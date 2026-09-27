/**
 * Coding Instructions proposal activities the member proposal branches
 * still share with #2563 (Fizzy #2563 spec §6 step 1, Fizzy #2738 spec §8):
 * readiness, the sweeper's branch sub-batches and Attach, and the retired
 * #2563 operation lane's registered stubs (Fizzy #2748). The activities
 * barrel re-exports this module, so EVERY export here becomes a schedulable
 * activity: helpers stay unexported or live in ./lib.
 *
 * Every write is conditional: a zero-row answer means another actor moved
 * first, and nothing after it runs.
 */
import {
	getProposalOperation,
	type InstructionPullRequestFailureCode,
	joinProposalBranch,
	type ProposalOperationRow,
	selectDueBranches,
	transitionPullRequest,
} from "@repo/database";
import { ApplicationFailure } from "@temporalio/activity";
import type {
	CloseProposalInput,
	CloseProposalResult,
	DispatchProposalInput,
	DispatchProposalResult,
	DueProposalSweep,
	MergeSyncDispatchInput,
	MergeSyncDispatchResult,
	ProposalReadinessInput,
	ProposalReadinessResult,
	ProposalSweepLimits,
	ReconcileProposalInput,
	ReconcileProposalResult,
	RecoverProposalInput,
	RecoverProposalResult,
} from "../lib/instruction-proposal-pull-request-types";
import { BRANCH_NAMING } from "./lib/instruction-branch-settlement";
import type {
	AttachBranchInput,
	AttachBranchResult,
	BranchSweepLimits,
	DueBranchSweep,
	WakeBranchInput,
} from "./lib/instruction-branch-types";
import { wakeBranchWorkflow } from "./lib/instruction-branch-wake";
import {
	activityCancellationSignal,
	asJson,
	assertMayContinue,
	failureJson,
	nextAttemptAt,
	ProposalStepFailure,
	proposalActivityBoundary,
	withProposalDeadline,
} from "./lib/instruction-proposal-boundary";
import {
	reconciledAudit,
	recordsOf,
} from "./lib/instruction-proposal-operation";

function failureCodeOf(
	row: ProposalOperationRow,
): InstructionPullRequestFailureCode | null {
	const failure = row.pullRequestFailure as { code?: unknown } | null;
	return typeof failure?.code === "string"
		? (failure.code as InstructionPullRequestFailureCode)
		: null;
}

// ---------------------------------------------------------------------------
// Readiness (spec §6 step 1)
// ---------------------------------------------------------------------------

const STOP = { kind: "stop" } as const;

/** The abandonment reaper's rejection entry (`rejectAbandonedInstructionSnapshot`). */
function rejectedAsAbandoned(row: ProposalOperationRow): boolean {
	return (
		Array.isArray(row.rejection) &&
		row.rejection.some(
			(r) =>
				typeof r === "object" &&
				r !== null &&
				(r as { path?: unknown }).path === "(upload)" &&
				(r as { reason?: unknown }).reason === "abandoned",
		)
	);
}

/**
 * A REJECTED snapshot whose operation is still pre-create (spec §4.4
 * "Validation REJECTED" and "Abandonment"): the verdict's own transaction
 * cancels it (`cancelRepositoryProposalForVerdict`), so reaching this means
 * that write never happened. Left QUEUED, the sweeper would hand it back to
 * readiness on every tick and readiness would stop every time, so readiness
 * applies the same transition: `CANCELED`, attempt
 * + 1, `VALIDATION_REJECTED`, one `pull_request_reconciled` (canceled) row,
 * fenced on the attempt read here. Only a row nothing was pushed or created
 * on: a head SHA or an issued push or create belongs to settlement.
 */
async function cancelForRejectedSnapshot(
	row: ProposalOperationRow,
	state: "QUEUED" | "OPENING" | "BLOCKED",
): Promise<void> {
	if (
		row.pullRequestHeadSha !== null ||
		recordsOf(row).some((r) => r.pushIssuedAt || r.createIssuedAt)
	) {
		return;
	}
	const abandoned = rejectedAsAbandoned(row);
	const failure = new ProposalStepFailure({
		code: "VALIDATION_REJECTED",
		phase: "validation",
		retryable: false,
		...(abandoned ? { params: { reason: "abandoned" } } : {}),
	});
	await transitionPullRequest({
		snapshotId: row.id,
		organizationId: row.organizationId,
		event: abandoned ? "abandoned" : "validation_rejected",
		from: [state],
		expectedAttempt: row.pullRequestAttempt,
		to: "CANCELED",
		bumpAttempt: true,
		data: {
			pullRequestFailure: asJson(failureJson(failure)),
			pullRequestNextAttemptAt: null,
		},
		audit: reconciledAudit(row, "canceled", false, "VALIDATION_REJECTED"),
	});
}

/**
 * The snapshot's validation verdict for the workflow's readiness loop. READY
 * and PENDING is `ready` with the attempt read alongside it (plan Decision
 * 7); RECEIVING and VALIDATING are `pending`; FAILED is `pending` with
 * `VALIDATION_FAILED` recorded once (spec §4.4); REJECTED, a missing or
 * mismatched row and every state an open cannot start from are `stop`; a
 * REJECTED snapshot's still pre-create operation is canceled first
 * (`cancelForRejectedSnapshot`). With `deadlineReached`, a still-pending
 * QUEUED row is moved to BLOCKED (`VALIDATION_TIMEOUT`) and the answer is
 * `stop`.
 */
export const checkInstructionProposalReadiness = proposalActivityBoundary<
	ProposalReadinessInput,
	ProposalReadinessResult
>("validation", STOP, async (input) => {
	const row = await getProposalOperation(input);
	if (
		!row ||
		row.proposalDestination !== "REPOSITORY" ||
		row.pullRequestOperationId !== input.operationId
	) {
		return STOP;
	}
	const state = row.pullRequestState;
	if (state !== "QUEUED" && state !== "OPENING" && state !== "BLOCKED") {
		return STOP;
	}
	const fence = {
		snapshotId: row.id,
		organizationId: row.organizationId,
		expectedAttempt: row.pullRequestAttempt,
		bumpAttempt: false,
	} as const;
	if (row.status === "READY") {
		if (row.proposalStatus !== "PENDING") {
			return STOP;
		}
		if (state === "QUEUED" && failureCodeOf(row) === "VALIDATION_FAILED") {
			await transitionPullRequest({
				...fence,
				event: "validation_ready",
				from: ["QUEUED"],
				to: "unchanged",
				data: {
					pullRequestFailure: null,
					pullRequestNextAttemptAt: null,
				},
			});
		}
		return { kind: "ready", attempt: row.pullRequestAttempt };
	}
	if (row.status === "REJECTED") {
		await cancelForRejectedSnapshot(row, state);
		return STOP;
	}
	if (
		row.status !== "RECEIVING" &&
		row.status !== "VALIDATING" &&
		row.status !== "FAILED"
	) {
		return STOP;
	}
	const validationFailed = row.status === "FAILED";
	if (input.deadlineReached) {
		if (state === "QUEUED") {
			const timeout = new ProposalStepFailure({
				code: "VALIDATION_TIMEOUT",
				phase: "validation",
				retryable: true,
			});
			await transitionPullRequest({
				...fence,
				event: "deadline",
				from: ["QUEUED"],
				to: "BLOCKED",
				data: {
					pullRequestFailure: asJson(failureJson(timeout)),
					pullRequestNextAttemptAt: nextAttemptAt(row, timeout),
				},
			});
		}
		return STOP;
	}
	if (
		validationFailed &&
		state === "QUEUED" &&
		failureCodeOf(row) !== "VALIDATION_FAILED"
	) {
		const failed = new ProposalStepFailure({
			code: "VALIDATION_FAILED",
			phase: "validation",
			retryable: true,
		});
		await transitionPullRequest({
			...fence,
			event: "validation_failed",
			from: ["QUEUED"],
			to: "unchanged",
			data: {
				pullRequestFailure: asJson(failureJson(failed)),
				pullRequestNextAttemptAt: nextAttemptAt(row, failed),
			},
		});
	}
	return { kind: "pending", validationFailed };
});

// ---------------------------------------------------------------------------
// The retired #2563 operation lane (Fizzy #2748)
// ---------------------------------------------------------------------------

/**
 * The #2563 per-proposal pull-request path is gone: admission writes member
 * branch proposals (v2) only, nothing writes a #2563 (v1) row any more, and
 * no v1 row is unresolved anywhere. The sweeper still proxies the lane's
 * seven activities on the path a tick recorded before
 * `V1_LANE_REMOVED_PATCH` takes (`instruction-proposal-pull-request-sweep.ts`).
 * Replaying that history executes no activity, but such a tick can straddle
 * a deploy: an activity it scheduled before the worker restarted, or one
 * its next workflow task schedules, then runs on the new worker. So each
 * name stays registered (the activity-registration parity guard requires it
 * too), as a stub that cannot break that tick:
 *
 * - the selection answers what the real query would: nothing is due, since
 *   each of its clauses selects only an unresolved v1 row;
 * - an action is scheduled only for a row that selection returned, so none
 *   is reachable; one that runs anyway fails non-retryably, and the tick
 *   counts that item failed and carries on.
 *
 * Remove them, and the lane's code in the sweeper, once no tick recorded
 * before the marker can still be open (`deprecatePatch`; a tick's execution
 * timeout is 270 s).
 */
function retiredLane(activity: string): never {
	throw ApplicationFailure.nonRetryable(
		`${activity} belongs to the retired per-proposal pull-request path; nothing is left for it to do`,
		"PROPOSAL_OPERATION_LANE_RETIRED",
	);
}

/** Retired: nothing is due, so a tick recorded before the removal queues no #2563 row. */
export async function selectDueInstructionProposalOperations(
	_limits: ProposalSweepLimits,
): Promise<DueProposalSweep> {
	return { close: [], recover: [], mergeSync: [], observe: [], restart: [] };
}

/** Retired: see "The retired #2563 operation lane". */
export async function deferInstructionProposalOperation(
	_input: DispatchProposalInput,
): Promise<{ deferred: boolean }> {
	return retiredLane("deferInstructionProposalOperation");
}

/** Retired: see "The retired #2563 operation lane". */
export async function closeInstructionProposalPullRequest(
	_input: CloseProposalInput,
): Promise<CloseProposalResult> {
	return retiredLane("closeInstructionProposalPullRequest");
}

/** Retired: see "The retired #2563 operation lane". */
export async function recoverInstructionProposalPullRequest(
	_input: RecoverProposalInput,
): Promise<RecoverProposalResult> {
	return retiredLane("recoverInstructionProposalPullRequest");
}

/** Retired: see "The retired #2563 operation lane". */
export async function reconcileInstructionProposalPullRequest(
	_input: ReconcileProposalInput,
): Promise<ReconcileProposalResult> {
	return retiredLane("reconcileInstructionProposalPullRequest");
}

/** Retired: see "The retired #2563 operation lane". */
export async function dispatchInstructionProposalMergeSync(
	_input: MergeSyncDispatchInput,
): Promise<MergeSyncDispatchResult> {
	return retiredLane("dispatchInstructionProposalMergeSync");
}

/** Retired: see "The retired #2563 operation lane". */
export async function dispatchInstructionProposalPullRequest(
	_input: DispatchProposalInput,
): Promise<DispatchProposalResult> {
	return retiredLane("dispatchInstructionProposalPullRequest");
}

// ---------------------------------------------------------------------------
// The sweeper's member proposal branch sub-batches (Fizzy #2738 spec §8)
// ---------------------------------------------------------------------------

/**
 * The branch rows of the five sub-batches, and Attach (`selectDueBranches`).
 * Read-only; system-wide by design, returning ids and each row's own tenant
 * columns. `untracked` branches are never selected.
 */
export async function selectDueInstructionProposalBranches(
	limits: BranchSweepLimits,
): Promise<DueBranchSweep> {
	return selectDueBranches(limits);
}

/**
 * Close, Recover and Restart's action on a branch row (spec §8 "wake"):
 * `signalWithStart(wake)` on its workflow, which is safe while it runs. The
 * sweeper never writes git; the workflow does the work.
 */
export async function wakeInstructionProposalBranch(
	input: WakeBranchInput,
): Promise<{ woken: true }> {
	return withProposalDeadline(input, async () => {
		assertMayContinue();
		await wakeBranchWorkflow(
			{
				branchId: input.branchId,
				projectId: input.projectId,
				organizationId: input.organizationId,
			},
			activityCancellationSignal(),
		);
		return { woken: true };
	});
}

/**
 * Attach (spec §8): a v2 proposal the admission left without a branch (its
 * join or wake failed after commit) joins its member's accepting branch,
 * whose workflow is then woken. A proposal the join leaves unjoined wakes
 * nothing; a stale destination is BLOCKED CONFIGURATION_CHANGED by the join
 * itself.
 */
export async function attachInstructionProposalToBranch(
	input: AttachBranchInput,
): Promise<AttachBranchResult> {
	return withProposalDeadline(input, async () => {
		assertMayContinue();
		const joined = await joinProposalBranch({
			snapshotId: input.snapshotId,
			organizationId: input.organizationId,
			naming: BRANCH_NAMING,
		});
		if (joined.kind !== "joined" && joined.kind !== "already") {
			return { kind: joined.kind };
		}
		assertMayContinue();
		await wakeBranchWorkflow(
			{
				branchId: joined.branchId,
				projectId: input.projectId,
				organizationId: input.organizationId,
			},
			activityCancellationSignal(),
		);
		return { kind: joined.kind, branchId: joined.branchId };
	});
}
