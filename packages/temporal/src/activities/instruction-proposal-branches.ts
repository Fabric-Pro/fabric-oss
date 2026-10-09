/**
 * Member proposal branch activities (Fizzy #2738 spec §6, §6.1-§6.5, §6.8).
 * The activities barrel re-exports this module, so EVERY export here becomes
 * a schedulable activity: helpers stay unexported or live in ./lib.
 *
 * Each activity runs under `withProposalDeadline` (its own start-to-close,
 * heartbeat ticker and cancellation) and heartbeats between git steps. A
 * cancellation or the deadline is rethrown for Temporal; a classified
 * failure is recorded (the proposal's BLOCKED failure for an append, the
 * §4.3 revert rows for a revert, the branch's failure for a create) and the
 * activity returns its typed outcome; an unclassified error is logged by
 * class name only.
 *
 * Authority (spec Decision 18): appends and creates re-check the member's
 * live permission, the frozen destination and the live repository identity;
 * a revert, recovery, lookup and release act under the recorded tenant and
 * integration, checking the repository identity (REPOSITORY_CHANGED stops
 * them, Decision 19).
 */
import {
	acceptsAppends,
	claimBranchAppend,
	getBranchPresentationInputs,
	getBranchProposal,
	getProposalBranch,
	getProposalOperation,
	isReleasableBranch,
	readBranchWork,
	recordBranchFailure,
	refuseBranchWithdrawal,
	transitionBranch,
	transitionPullRequest,
} from "@repo/database";
import { logger } from "@repo/logs";
import { PROPOSAL_VALIDATION_CLOCK_MS } from "../lib/instruction-proposal-pull-request-types";
import { checkInstructionProposalReadiness } from "./instruction-proposal-pull-requests";
import { runBranchAppend } from "./lib/instruction-branch-append";
import { runClassify } from "./lib/instruction-branch-classify";
import {
	deferLookup,
	runCreate,
	runLookup,
	runRelease,
	runRetry,
} from "./lib/instruction-branch-create";
import {
	type BranchMergeSyncResult,
	runBranchMergeSync,
} from "./lib/instruction-branch-merge-sync";
import {
	recoverOperation,
	reobserveProposal,
} from "./lib/instruction-branch-recovery";
import {
	RevertPushUnanswered,
	runBranchRevert,
} from "./lib/instruction-branch-revert";
import {
	runConfirmations,
	runReconcile,
	runRehome,
	runSettle,
} from "./lib/instruction-branch-settlement";
import { renderBranchPresentation } from "./lib/instruction-branch-support";
import type {
	AppendBranchProposalInput,
	AppendOutcome,
	BranchIds,
	CheckBranchProposalReadinessInput,
	CheckBranchProposalReadinessResult,
	ClaimBranchProposalInput,
	ClaimBranchProposalResult,
	ClassifyBranchInput,
	ClassifyBranchResult,
	CreateBranchPullRequestInput,
	CreateBranchPullRequestResult,
	DispatchBranchMergeSyncInput,
	LookupBranchPullRequestInput,
	LookupBranchPullRequestResult,
	NextBranchWorkResult,
	ReconcileBranchInput,
	ReconcileBranchResult,
	RecoverBranchOperationInput,
	RecoverBranchOperationResult,
	RehomeBranchProposalsInput,
	RehomeBranchProposalsResult,
	ReleaseBranchInput,
	ReleaseBranchResult,
	ReobserveProposalOperationsInput,
	ReobserveProposalOperationsResult,
	RetryBranchOpeningInput,
	RetryBranchOpeningResult,
	RevertBranchProposalInput,
	RevertBranchProposalResult,
	RunBranchConfirmationsInput,
	SettleBranchInput,
	SettleBranchResult,
} from "./lib/instruction-branch-types";
import {
	activityCancellationSignal,
	asJson,
	assertMayContinue,
	assertTimeFor,
	cancellationOf,
	errorClassName,
	failureJson,
	nextAttemptAt,
	ProposalDeadlineExceeded,
	ProposalStepFailure,
	withProposalDeadline,
} from "./lib/instruction-proposal-boundary";

const MINUTE_MS = 60 * 1000;

/** Rethrows a cancellation or the deadline; logs anything else by class name only. */
function stopOrLog(error: unknown, activity: string): void {
	const cancelled = cancellationOf(error);
	if (cancelled) {
		if (cancelled instanceof ProposalDeadlineExceeded) {
			logger.warn(
				{ event: "instruction_proposal_branch.deadline", activity },
				"Instruction proposal branch activity stopped at its deadline",
			);
		}
		throw cancelled;
	}
	logger.warn(
		{
			event: "instruction_proposal_branch.failed",
			activity,
			errorClass: errorClassName(error),
			...(error instanceof ProposalStepFailure
				? { code: error.code }
				: {}),
		},
		"Instruction proposal branch activity failed",
	);
}

/** A sanitized error for Temporal's retry: never the cause's message. */
function sanitized(activity: string): Error {
	return new Error(`Instruction proposal branch ${activity} failed`);
}

/** Decision 19: a changed repository identity stops the branch itself. */
async function recordRepositoryChanged(
	ids: { branchId: string; organizationId: string },
	failure: ProposalStepFailure,
): Promise<void> {
	if (failure.code === "REPOSITORY_CHANGED") {
		await recordBranchFailure({ ...ids, failure: failureJson(failure) });
	}
}

// ---------------------------------------------------------------------------
// Claim (spec §6.1)
// ---------------------------------------------------------------------------

/**
 * `claimBranchAppend`, with the branch's presentation rendered for its first
 * claim. A presentation that cannot be rendered safely claims nothing (the
 * head proposal stays QUEUED) and blocks the branch ATTRIBUTION_REJECTED,
 * which stops it accepting appends.
 */
export async function claimBranchProposal(
	input: ClaimBranchProposalInput,
): Promise<ClaimBranchProposalResult> {
	const ids = {
		branchId: input.branchId,
		organizationId: input.organizationId,
	};
	const branch = await getProposalBranch(ids);
	if (!branch || !acceptsAppends(branch)) {
		return { kind: "none" };
	}
	let presentation: { title: string; body: string } | undefined;
	if (branch.presentation === null) {
		const names = await getBranchPresentationInputs(ids);
		const rendered = renderBranchPresentation(
			names ?? { memberName: null, projectName: null },
		);
		if (!rendered.ok) {
			const failure = failureJson(
				new ProposalStepFailure({
					code: "ATTRIBUTION_REJECTED",
					phase: "append",
					retryable: false,
				}),
			);
			const to =
				branch.state === "PENDING" || branch.state === "OPENING"
					? "BLOCKED"
					: "unchanged";
			await transitionBranch({
				...ids,
				from: [branch.state],
				expectedAttempt: branch.attempt,
				to,
				bumpAttempt: true,
				data: { failure: asJson(failure), nextAttemptAt: null },
			});
			return { kind: "attribution_rejected" };
		}
		presentation = rendered.presentation;
	}
	return claimBranchAppend({ ...ids, presentation });
}

// ---------------------------------------------------------------------------
// Append (spec §6.3, §6.4)
// ---------------------------------------------------------------------------

/** The proposal's BLOCKED failure at the claimed attempt (#2563's `open_failure`). */
async function recordAppendFailure(
	input: AppendBranchProposalInput,
	failure: ProposalStepFailure,
): Promise<boolean> {
	await recordRepositoryChanged(input, failure);
	const row = await getBranchProposal({
		snapshotId: input.snapshotId,
		organizationId: input.organizationId,
	});
	if (!row) {
		return false;
	}
	const moved = await transitionPullRequest({
		snapshotId: input.snapshotId,
		organizationId: input.organizationId,
		event: "open_failure",
		from: ["OPENING"],
		expectedAttempt: input.proposalAttempt,
		to: "BLOCKED",
		bumpAttempt: false,
		data: {
			pullRequestFailure: asJson(failureJson(failure)),
			pullRequestNextAttemptAt: nextAttemptAt(row, failure),
		},
	});
	return moved.ok;
}

/**
 * `appendBranchProposal` (spec §6.4): the claimed proposal's one commit on
 * its member's branch. 15 min start-to-close, 60 s heartbeat.
 */
export async function appendBranchProposal(
	input: AppendBranchProposalInput,
): Promise<{ outcome: AppendOutcome }> {
	return withProposalDeadline(input, async () => {
		try {
			assertMayContinue();
			const outcome = await runBranchAppend({
				branchId: input.branchId,
				organizationId: input.organizationId,
				snapshotId: input.snapshotId,
				proposalAttempt: input.proposalAttempt,
				branchAttempt: input.branchAttempt,
				signal: activityCancellationSignal(),
			});
			return { outcome };
		} catch (error) {
			stopOrLog(error, "append");
			const failure =
				error instanceof ProposalStepFailure
					? error
					: new ProposalStepFailure({
							code: "UNEXPECTED",
							phase: "append",
							retryable: true,
							params: { phase: "append" },
						});
			try {
				const recorded = await recordAppendFailure(input, failure);
				if (!recorded) {
					return { outcome: "stopped" };
				}
			} catch (recordError) {
				stopOrLog(recordError, "append_record");
				throw sanitized("append");
			}
			return {
				outcome:
					error instanceof ProposalStepFailure
						? "blocked"
						: "retry_later",
			};
		}
	});
}

// ---------------------------------------------------------------------------
// Recovery and re-observation (spec §6.2)
// ---------------------------------------------------------------------------

/**
 * `recoverBranchOperation` (spec §6.2): an issued operation resolved from
 * the ref's complete history. `retry_later` when the history could not be
 * fetched: nothing is written, recovery never guesses.
 */
export async function recoverBranchOperation(
	input: RecoverBranchOperationInput,
): Promise<RecoverBranchOperationResult> {
	return withProposalDeadline(input, async () => {
		try {
			assertMayContinue();
			const outcome = await recoverOperation({
				branchId: input.branchId,
				organizationId: input.organizationId,
				operationId: input.operationId,
				signal: activityCancellationSignal(),
			});
			return { outcome };
		} catch (error) {
			stopOrLog(error, "recover");
			if (!(error instanceof ProposalStepFailure)) {
				throw sanitized("recover");
			}
			await recordRepositoryChanged(input, error);
			return { outcome: "retry_later" };
		}
	});
}

/**
 * `reobserveProposalOperations` (spec §6.2 step 5): a proposal's `unknown`
 * operations resolved once more before any new issuance (Try again,
 * withdraw-again). `changed` when that changed its lifecycle.
 */
export async function reobserveProposalOperations(
	input: ReobserveProposalOperationsInput,
): Promise<ReobserveProposalOperationsResult> {
	return withProposalDeadline(input, async () => {
		try {
			assertMayContinue();
			return await reobserveProposal({
				branchId: input.branchId,
				organizationId: input.organizationId,
				snapshotId: input.snapshotId,
				signal: activityCancellationSignal(),
			});
		} catch (error) {
			stopOrLog(error, "reobserve");
			if (!(error instanceof ProposalStepFailure)) {
				throw sanitized("reobserve");
			}
			await recordRepositoryChanged(input, error);
			return { changed: false };
		}
	});
}

// ---------------------------------------------------------------------------
// Create, lookup, retry opening, release (spec §6.5, Decision 17)
// ---------------------------------------------------------------------------

/** `createBranchPullRequest` (spec §6.5): the branch's one pull request. */
export async function createBranchPullRequest(
	input: CreateBranchPullRequestInput,
): Promise<CreateBranchPullRequestResult> {
	return withProposalDeadline(input, async () => {
		try {
			assertMayContinue();
			const outcome = await runCreate({
				branchId: input.branchId,
				organizationId: input.organizationId,
				branchAttempt: input.branchAttempt,
				signal: activityCancellationSignal(),
			});
			return { outcome };
		} catch (error) {
			stopOrLog(error, "create");
			throw sanitized("create");
		}
	});
}

/** `lookupBranchPullRequest` (spec §6 loop item 9): an outstanding create reconciled. */
export async function lookupBranchPullRequest(
	input: LookupBranchPullRequestInput,
): Promise<LookupBranchPullRequestResult> {
	return withProposalDeadline(input, async () => {
		try {
			assertMayContinue();
			const outcome = await runLookup({
				branchId: input.branchId,
				organizationId: input.organizationId,
				signal: activityCancellationSignal(),
			});
			return { outcome };
		} catch (error) {
			stopOrLog(error, "lookup");
			if (!(error instanceof ProposalStepFailure)) {
				throw sanitized("lookup");
			}
			await recordRepositoryChanged(input, error);
			const branch = await getProposalBranch(input);
			if (branch) {
				// REPOSITORY_CHANGED keeps the marker outstanding until Stop
				// tracking; without a backoff the loop would look at once again.
				await deferLookup(
					branch,
					error.code === "REPOSITORY_CHANGED"
						? 6 * 60 * MINUTE_MS
						: 15 * MINUTE_MS,
				);
			}
			return { outcome: "inconclusive" };
		}
	});
}

/** `retryBranchOpening` (Decision 17): a member's Retry opening. */
export async function retryBranchOpening(
	input: RetryBranchOpeningInput,
): Promise<RetryBranchOpeningResult> {
	return withProposalDeadline(input, async () => {
		try {
			assertMayContinue();
			const outcome = await runRetry({
				branchId: input.branchId,
				organizationId: input.organizationId,
				branchAttempt: input.branchAttempt,
				signal: activityCancellationSignal(),
			});
			return { outcome };
		} catch (error) {
			stopOrLog(error, "retry");
			throw sanitized("retry");
		}
	});
}

/**
 * A release that kept the branch (a lookup that could not answer, a
 * provider's refusal of the delete, a failure) waits 15 minutes before the
 * loop's `release` item is due again, failure-only; otherwise the loop,
 * which runs `release` whenever the branch is releasable and due, would
 * ask again at once.
 */
async function deferKeptRelease(input: ReleaseBranchInput): Promise<void> {
	const branch = await getProposalBranch(input);
	if (branch && !branch.untracked && isReleasableBranch(branch)) {
		await deferLookup(branch, 15 * MINUTE_MS);
	}
}

/** `releaseBranch` (spec §4.4 "Release", §6.5). */
export async function releaseBranch(
	input: ReleaseBranchInput,
): Promise<ReleaseBranchResult> {
	return withProposalDeadline(input, async () => {
		try {
			assertMayContinue();
			const outcome = await runRelease({
				branchId: input.branchId,
				organizationId: input.organizationId,
				branchAttempt: input.branchAttempt,
				signal: activityCancellationSignal(),
			});
			if (outcome === "kept") {
				await deferKeptRelease(input);
			}
			return { outcome };
		} catch (error) {
			stopOrLog(error, "release");
			if (!(error instanceof ProposalStepFailure)) {
				throw sanitized("release");
			}
			await recordRepositoryChanged(input, error);
			await deferKeptRelease(input);
			return { outcome: "kept" };
		}
	});
}

// ---------------------------------------------------------------------------
// Revert (spec §6.8)
// ---------------------------------------------------------------------------

/**
 * `revertBranchProposal` (spec §6.8): the withdrawal of an appended change.
 * A non-retryable refusal is the §4.3 revert-failure row (OPEN, the failure,
 * the command cleared, a `change` intent cleared and a `branch` one kept);
 * a retryable one is failure-only on CLOSE_REQUESTED with its backoff; a
 * push the remote never answered leaves the operation to recovery.
 * 15 min start-to-close, 60 s heartbeat.
 */
export async function revertBranchProposal(
	input: RevertBranchProposalInput,
): Promise<RevertBranchProposalResult> {
	return withProposalDeadline(input, async () => {
		try {
			assertMayContinue();
			const outcome = await runBranchRevert({
				branchId: input.branchId,
				organizationId: input.organizationId,
				snapshotId: input.snapshotId,
				proposalAttempt: input.proposalAttempt,
				signal: activityCancellationSignal(),
			});
			return { outcome };
		} catch (error) {
			stopOrLog(error, "revert");
			if (error instanceof RevertPushUnanswered) {
				return { outcome: "unknown" };
			}
			const failure =
				error instanceof ProposalStepFailure
					? error
					: new ProposalStepFailure({
							code: "UNEXPECTED",
							phase: "revert",
							retryable: true,
							params: { phase: "revert" },
						});
			try {
				if (!failure.retryable) {
					const json = failureJson(failure);
					const refused = await refuseBranchWithdrawal({
						branchId: input.branchId,
						organizationId: input.organizationId,
						snapshotId: input.snapshotId,
						proposalAttempt: input.proposalAttempt,
						failure: json,
						...(failure.code === "REPOSITORY_CHANGED"
							? { branchFailure: json }
							: {}),
					});
					return {
						outcome: refused.ok ? "withdraw_conflict" : "stopped",
					};
				}
				const row = await getBranchProposal({
					snapshotId: input.snapshotId,
					organizationId: input.organizationId,
				});
				if (!row) {
					return { outcome: "stopped" };
				}
				const recorded = await transitionPullRequest({
					snapshotId: input.snapshotId,
					organizationId: input.organizationId,
					event: "failure",
					from: ["CLOSE_REQUESTED"],
					expectedAttempt: input.proposalAttempt,
					to: "unchanged",
					bumpAttempt: false,
					data: {
						pullRequestFailure: asJson(failureJson(failure)),
						pullRequestNextAttemptAt: nextAttemptAt(row, failure),
					},
				});
				return { outcome: recorded.ok ? "retry_later" : "stopped" };
			} catch (recordError) {
				stopOrLog(recordError, "revert_record");
				throw sanitized("revert");
			}
		}
	});
}

// ---------------------------------------------------------------------------
// The loop's read and the head's readiness (spec §6 items 12-13)
// ---------------------------------------------------------------------------

/**
 * `nextBranchWorkItem`: the loop's read (`readBranchWork`), with an idle
 * timer as a delay on the database clock, never a date the workflow would
 * compare with its own clock.
 */
export async function nextBranchWorkItem(
	input: BranchIds,
): Promise<NextBranchWorkResult> {
	const read = await readBranchWork({
		branchId: input.branchId,
		organizationId: input.organizationId,
	});
	const w = read.work;
	return {
		work:
			w.kind === "idle"
				? {
						kind: "idle",
						wakeInMs:
							w.wakeAt === null
								? null
								: Math.max(
										0,
										w.wakeAt.getTime() -
											read.databaseNow.getTime(),
									),
					}
				: w,
		branchAttempt: read.branchAttempt,
	};
}

/** The failure JSON's `code` and `at`, when there is one. */
function failureAt(value: unknown): { code: string | null; at: number | null } {
	if (value === null || typeof value !== "object") {
		return { code: null, at: null };
	}
	const f = value as { code?: unknown; at?: unknown };
	const at = typeof f.at === "string" ? Date.parse(f.at) : Number.NaN;
	return {
		code: typeof f.code === "string" ? f.code : null,
		at: Number.isFinite(at) ? at : null,
	};
}

/**
 * `checkBranchProposalReadiness` (spec §6 item 12): #2563's readiness for
 * the branch's head proposal while it validates, with #2563's 6 h clock.
 * The clock runs on the database: from the snapshot's creation, restarted
 * by a recorded VALIDATION_FAILED (a transition into FAILED), so a
 * continued-as-new or restarted workflow keeps it. Once it has run out, a
 * still-QUEUED head becomes BLOCKED VALIDATION_TIMEOUT and the answer is
 * `stop`.
 */
export async function checkBranchProposalReadiness(
	input: CheckBranchProposalReadinessInput,
): Promise<CheckBranchProposalReadinessResult> {
	const [row, placed] = await Promise.all([
		getProposalOperation({
			snapshotId: input.snapshotId,
			projectId: input.projectId,
			organizationId: input.organizationId,
		}),
		getBranchProposal({
			snapshotId: input.snapshotId,
			organizationId: input.organizationId,
		}),
	]);
	if (
		!row ||
		!placed ||
		placed.proposalBranchId !== input.branchId ||
		row.pullRequestOperationId === null
	) {
		return { kind: "stop" };
	}
	const failed = failureAt(row.pullRequestFailure);
	const anchor = Math.max(
		row.createdAt.getTime(),
		failed.code === "VALIDATION_FAILED" && failed.at !== null
			? failed.at
			: 0,
	);
	const answer = await checkInstructionProposalReadiness({
		snapshotId: row.id,
		projectId: row.projectId,
		organizationId: row.organizationId,
		operationId: row.pullRequestOperationId,
		deadlineReached:
			row.databaseNow.getTime() - anchor >= PROPOSAL_VALIDATION_CLOCK_MS,
		...(input.deadlineAt !== undefined
			? { deadlineAt: input.deadlineAt }
			: {}),
	});
	return { kind: answer.kind };
}

// ---------------------------------------------------------------------------
// Observation, classification, rehome (spec §6.6)
// ---------------------------------------------------------------------------

/**
 * `reconcileInstructionProposalBranch` (spec §6.6 "Observation"): the
 * sweeper's Observe, #2563's reconcile fenced on the branch attempt read at
 * selection. Answers the branch's state as it now stands.
 */
export async function reconcileInstructionProposalBranch(
	input: ReconcileBranchInput,
): Promise<ReconcileBranchResult> {
	return withProposalDeadline(input, async () => {
		try {
			assertMayContinue();
			const state = await runReconcile({
				branchId: input.branchId,
				organizationId: input.organizationId,
				...(input.expectedAttempt !== undefined
					? { expectedAttempt: input.expectedAttempt }
					: {}),
				signal: activityCancellationSignal(),
			});
			return { state };
		} catch (error) {
			stopOrLog(error, "reconcile");
			throw sanitized("reconcile");
		}
	});
}

/** `classifyBranch` (spec §6.6 "Classification", Decision 14). */
export async function classifyBranch(
	input: ClassifyBranchInput,
): Promise<ClassifyBranchResult> {
	return withProposalDeadline(input, async () => {
		try {
			assertMayContinue();
			const outcome = await runClassify({
				branchId: input.branchId,
				organizationId: input.organizationId,
				factsRevision: input.factsRevision,
				signal: activityCancellationSignal(),
			});
			if (outcome === "done" || outcome === "unverified") {
				await dispatchMergeSyncNow(input);
			}
			return { outcome };
		} catch (error) {
			stopOrLog(error, "classify");
			throw sanitized("classify");
		}
	});
}

/** The least budget left for which the immediate merge sync is attempted. */
const IMMEDIATE_MERGE_SYNC_BUDGET_MS = 90_000;

/**
 * The merge sync a classification just requested, asked for at once rather
 * than at the sweeper's next tick, which for a repository-backed project is
 * minutes in which the row still reads "syncing" though the head already
 * shows the merge. The classification is already committed, so this never
 * fails the activity (a retry would only answer `stale_revision`): without
 * the budget it is left to the sweeper, and any failure, the deadline
 * included, is logged. Only the activity's own cancellation is rethrown.
 */
async function dispatchMergeSyncNow(input: ClassifyBranchInput): Promise<void> {
	try {
		assertTimeFor(IMMEDIATE_MERGE_SYNC_BUDGET_MS);
		await runBranchMergeSync({
			branchId: input.branchId,
			organizationId: input.organizationId,
			signal: activityCancellationSignal(),
		});
	} catch (error) {
		const stopped = cancellationOf(error);
		if (stopped instanceof ProposalDeadlineExceeded) {
			logger.info(
				{ event: "instruction_proposal_branch.merge_sync_deferred" },
				"Immediate merge sync left to the sweeper: no time left",
			);
			return;
		}
		stopOrLog(error, "classify_merge_sync");
	}
}

/** `rehomeBranchProposals` (spec §6.6 "Rehome", §4.3). */
export async function rehomeBranchProposals(
	input: RehomeBranchProposalsInput,
): Promise<RehomeBranchProposalsResult> {
	return withProposalDeadline(input, async () => {
		try {
			assertMayContinue();
			return await runRehome({
				branchId: input.branchId,
				organizationId: input.organizationId,
				snapshotIds: input.snapshotIds,
				signal: activityCancellationSignal(),
			});
		} catch (error) {
			stopOrLog(error, "rehome");
			throw sanitized("rehome");
		}
	});
}

// ---------------------------------------------------------------------------
// Settlement, confirmations, merge sync (spec §6.6, §6.7)
// ---------------------------------------------------------------------------

/** `settleBranch` (spec §6.7, Decision 11): close, start over, deletion. */
export async function settleBranch(
	input: SettleBranchInput,
): Promise<SettleBranchResult> {
	return withProposalDeadline(input, async () => {
		try {
			assertMayContinue();
			const outcome = await runSettle({
				branchId: input.branchId,
				organizationId: input.organizationId,
				branchAttempt: input.branchAttempt,
				signal: activityCancellationSignal(),
			});
			return { outcome };
		} catch (error) {
			stopOrLog(error, "settle");
			throw sanitized("settle");
		}
	});
}

/** `runBranchConfirmations` (spec §6.7 step 4): the branch's due confirmation. */
export async function runBranchConfirmations(
	input: RunBranchConfirmationsInput,
): Promise<{ outcome: "confirmed" | "deferred" | "not_due" }> {
	return withProposalDeadline(input, async () => {
		try {
			assertMayContinue();
			const outcome = await runConfirmations({
				branchId: input.branchId,
				organizationId: input.organizationId,
				signal: activityCancellationSignal(),
			});
			return { outcome };
		} catch (error) {
			stopOrLog(error, "confirm");
			throw sanitized("confirm");
		}
	});
}

/** `dispatchBranchMergeSync` (spec §6.6 "Merge sync", #2563 §9.1). */
export async function dispatchBranchMergeSync(
	input: DispatchBranchMergeSyncInput,
): Promise<{ outcome: BranchMergeSyncResult }> {
	return withProposalDeadline(input, async () => {
		try {
			assertMayContinue();
			const outcome = await runBranchMergeSync({
				branchId: input.branchId,
				organizationId: input.organizationId,
				signal: activityCancellationSignal(),
			});
			return { outcome };
		} catch (error) {
			stopOrLog(error, "merge_sync");
			throw sanitized("merge_sync");
		}
	});
}
