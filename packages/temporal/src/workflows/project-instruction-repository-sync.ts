/**
 * Coding Instructions repository sync (design 2026-09-23 §5.2).
 *
 * begin -> acquire -> child snapshot workflow -> record, with `record` in the
 * boundary `finally` under `CancellationScope.nonCancellable` so every run
 * that inserted a run row completes it (without a context, `record` finds
 * the row by the workflow's run id). It is the fast path for cleanup
 * and bookkeeping, not the only one: the hourly reaper reconciles anything a
 * terminated run left behind (§5.7).
 *
 * Workflow sandbox: imports only pure modules (`@repo/instructions/workflow-ids`,
 * `../lib/instruction-sync-types`, `../task-queues`), never a package barrel.
 */
import { instructionSnapshotWorkflowId } from "@repo/instructions/workflow-ids";
import { WorkflowExecutionAlreadyStartedError } from "@temporalio/common";
import {
	ActivityCancellationType,
	ApplicationFailure,
	CancellationScope,
	type ChildWorkflowHandle,
	getExternalWorkflowHandle,
	isCancellation,
	proxyActivities,
	startChild,
	WorkflowIdReusePolicy,
	workflowInfo,
} from "@temporalio/workflow";
import type * as activities from "../activities";
import {
	type InstructionSyncErrorCode,
	type InstructionSyncWorkflowInput,
	isInstructionSyncErrorCode,
	NON_RETRYABLE_INSTRUCTION_SYNC_ERRORS,
	type RecordSyncRunInput,
	type RecordSyncRunResult,
	type SnapshotChildResult,
	type SyncFailureDetails,
	type SyncRunContext,
} from "../lib/instruction-sync-types";
import { INSTRUCTION_SYNC_ACTIVITY_TASK_QUEUE } from "../task-queues";
import { projectInstructionSnapshotWorkflow } from "./project-instruction-snapshot";

const onSyncQueue = {
	taskQueue: INSTRUCTION_SYNC_ACTIVITY_TASK_QUEUE,
} as const;

const { beginInstructionRepositorySyncRun } = proxyActivities<
	typeof activities
>({
	...onSyncQueue,
	startToCloseTimeout: "1 minute",
	// `begin` inserts the run receipt and then keeps working. Under the SDK
	// default (TRY_CANCEL) a cancelled workflow would reach `record` while
	// `begin` is still running, before its insert is visible, and leave the
	// receipt unfinished. WAIT_CANCELLATION_COMPLETED holds the cancellation
	// until the current attempt has completed or failed; it never
	// heartbeats, so at the latest that is its startToClose (1 min). That
	// bounds what the WORKFLOW waits for, not the attempt's code: an attempt
	// Temporal gives up on at startToClose keeps running on its worker, and
	// its receipt insert can still commit after a retry has begun the run and
	// `record` has swept. The hourly reaper closes such a receipt once this
	// run has ended (`reapStrandedInstructionSyncReceipts`, Fizzy #2672).
	cancellationType: ActivityCancellationType.WAIT_CANCELLATION_COMPLETED,
	retry: {
		initialInterval: "1s",
		maximumInterval: "30s",
		backoffCoefficient: 2,
		maximumAttempts: 5,
	},
});

const { acquireInstructionTreeFromRepository } = proxyActivities<
	typeof activities
>({
	...onSyncQueue,
	startToCloseTimeout: "10 minutes",
	heartbeatTimeout: "60 seconds",
	// A cancelled workflow must not let `record` (nonCancellable) race this
	// activity's own writes (`createInstructionSnapshot`, `stageBytes`):
	// WAIT_CANCELLATION_COMPLETED holds the cancellation open until the
	// activity actually stops. Its git steps abort on the cancellation
	// signal (`activity-liveness.ts`) and it heartbeats continuously via the
	// ticker, so in practice the wait is normally seconds — but `stageBytes`
	// never checks the signal, so an attempt stuck there is bounded by
	// startToClose (10 min), not the heartbeat timeout (review S2).
	cancellationType: ActivityCancellationType.WAIT_CANCELLATION_COMPLETED,
	retry: {
		initialInterval: "2s",
		maximumInterval: "30s",
		backoffCoefficient: 2,
		// Spec §5.2: up to three retries on CLONE_FAILED, STORAGE_FAILED and
		// INTEGRATION_UNAVAILABLE; every other typed failure is final.
		maximumAttempts: 4,
		nonRetryableErrorTypes: [...NON_RETRYABLE_INSTRUCTION_SYNC_ERRORS],
	},
});

const { awaitInstructionSnapshotSettled } = proxyActivities<typeof activities>({
	...onSyncQueue,
	startToCloseTimeout: "12 minutes",
	heartbeatTimeout: "60 seconds",
	// Unlimited retry, not 3 attempts (review S1): this activity is read-only
	// and idempotent, and the parent must never record while the adopted
	// child is still open. A client error or a heartbeat blip during the
	// 3-hour wait must be retried forever, not surfaced as a failure that
	// lets `runChild`/`settleAdoptedChild` return early.
	retry: {
		initialInterval: "5s",
		maximumInterval: "1 minute",
		backoffCoefficient: 2,
	},
});

const { recordInstructionRepositorySyncRun } = proxyActivities<
	typeof activities
>({
	...onSyncQueue,
	startToCloseTimeout: "2 minutes",
	retry: {
		initialInterval: "1s",
		maximumInterval: "1 minute",
		backoffCoefficient: 2,
		maximumAttempts: 10,
	},
});

/** 18 settle polls of up to 10 minutes: the spec's 3 hours (plan Decision 15). */
const SETTLE_POLLS_BEFORE_CANCEL = 18;

export async function projectInstructionRepositorySyncWorkflow(
	input: InstructionSyncWorkflowInput,
): Promise<RecordSyncRunResult> {
	const state: RecordSyncRunInput = {
		projectId: input.projectId,
		organizationId: input.organizationId,
		trigger: input.trigger,
		// Lets `record` find `begin`'s receipt even when `begin` never
		// returned a context (it threw or was cancelled after inserting).
		workflowRunId: workflowInfo().runId,
		context: null,
		skipped: false,
		unchanged: false,
		snapshotId: null,
		commitSha: null,
		error: null,
		childResult: null,
	};
	let result: RecordSyncRunResult = { recorded: false, status: null };
	try {
		await runSync(input, state);
	} finally {
		result = await CancellationScope.nonCancellable(() =>
			recordInstructionRepositorySyncRun(state),
		);
	}
	return result;
}

async function runSync(
	input: InstructionSyncWorkflowInput,
	state: RecordSyncRunInput,
): Promise<void> {
	const begun = await beginInstructionRepositorySyncRun({
		...input,
		workflowRunId: workflowInfo().runId,
	});
	if (!begun.ok) {
		state.context = begun.context ?? null;
		if ("skipped" in begun) {
			state.skipped = true;
		} else {
			state.error = begun.error;
		}
		return;
	}
	state.context = begun.context;
	let acquired: Awaited<
		ReturnType<typeof acquireInstructionTreeFromRepository>
	>;
	try {
		acquired = await acquireInstructionTreeFromRepository(begun.context);
	} catch (error) {
		if (isCancellation(error)) {
			// Not a sync failure: rethrow without setting `state.error`, so a
			// cancelled acquisition is never recorded as CLONE_FAILED (review
			// N1). `record` derives the result from the row.
			throw error;
		}
		const failure = typedFailure(error);
		state.error = failure.code;
		state.commitSha = failure.details.commitSha ?? null;
		state.snapshotId = failure.details.snapshotId ?? null;
		return;
	}
	state.commitSha = acquired.commitSha;
	if (acquired.outcome === "unchanged") {
		state.unchanged = true;
		return;
	}
	state.snapshotId = acquired.snapshotId;
	state.childResult = await runChild(begun.context, acquired.snapshotId);
}

/**
 * The acquisition's typed failure, read from the innermost
 * `ApplicationFailure` of the `ActivityFailure` chain. Anything untyped (an
 * exhausted retry of a thrown TypeError, a timeout) is a failed fetch.
 */
function typedFailure(error: unknown): {
	code: InstructionSyncErrorCode;
	details: SyncFailureDetails;
} {
	let current: unknown = error;
	for (let depth = 0; depth < 10 && current instanceof Error; depth++) {
		if (
			current instanceof ApplicationFailure &&
			isInstructionSyncErrorCode(current.type)
		) {
			const first = current.details?.[0];
			const details =
				first !== null && typeof first === "object"
					? (first as SyncFailureDetails)
					: {};
			return { code: current.type, details };
		}
		current = current.cause;
	}
	return { code: "CLONE_FAILED", details: {} };
}

/**
 * Spec §5.2 step 3. The child inherits this workflow's task queue and, by
 * default, is terminated with it: a parent that is gone cannot record, and
 * §5.7 reconciles the row.
 */
async function runChild(
	context: SyncRunContext,
	snapshotId: string,
): Promise<SnapshotChildResult | null> {
	let child: ChildWorkflowHandle<typeof projectInstructionSnapshotWorkflow>;
	try {
		child = await startChild(projectInstructionSnapshotWorkflow, {
			workflowId: instructionSnapshotWorkflowId(snapshotId),
			workflowIdReusePolicy: WorkflowIdReusePolicy.REJECT_DUPLICATE,
			args: [
				{
					snapshotId,
					projectId: context.projectId,
					organizationId: context.organizationId,
					userId: context.actingUserId,
				},
			],
		});
	} catch (error) {
		if (error instanceof WorkflowExecutionAlreadyStartedError) {
			// A retry adopted a snapshot whose child already exists: wait for
			// it rather than starting another.
			return settleAdoptedChild(snapshotId);
		}
		throw error;
	}
	try {
		return await child.result();
	} catch (error) {
		if (isCancellation(error)) {
			throw error;
		}
		// The child failed and marked its row FAILED, which `record` reads.
		return null;
	}
}

/**
 * The parent never ends while a child that can still publish is open. After
 * 3 hours of `pending` it cancels the child and waits for it to close before
 * recording. A timeout is never a verdict.
 */
async function settleAdoptedChild(
	snapshotId: string,
): Promise<SnapshotChildResult | null> {
	for (let poll = 0; poll < SETTLE_POLLS_BEFORE_CANCEL; poll++) {
		const settled = await awaitInstructionSnapshotSettled({ snapshotId });
		if (settled.settled) {
			return settled.childResult ?? null;
		}
	}
	try {
		await getExternalWorkflowHandle(
			instructionSnapshotWorkflowId(snapshotId),
		).cancel();
	} catch (error) {
		if (isCancellation(error)) {
			throw error;
		}
		// The child may have already closed between the last poll and this
		// cancel command, which can make the server refuse the cancel
		// (review N2, unverified race). Either way, fall through to the loop
		// below: it already handles a closed child, and losing `childResult`
		// here would drop the publish reason for no reason.
	}
	// Unbounded on purpose (spec §5.2: "waits for it to close"). The backstop
	// is not a poll count but Temporal's history-size limit: a child wedged
	// in a workflow-task failure that never processes its cancellation runs
	// this parent for roughly 59 days before history size terminates it, and
	// the hourly reaper (§5.7) reconciles the run row independently of
	// whether this loop ever returns (review N3).
	for (;;) {
		const settled = await awaitInstructionSnapshotSettled({ snapshotId });
		if (settled.settled) {
			return settled.childResult ?? null;
		}
	}
}
