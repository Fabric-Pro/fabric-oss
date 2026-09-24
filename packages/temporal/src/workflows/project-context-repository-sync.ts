/**
 * Living Memory repository sync (design 2026-09-23 §5.2, Fizzy #2657).
 *
 * begin -> sync -> record, with `record` in the boundary `finally` under
 * `CancellationScope.nonCancellable`, so every run whose receipt `begin`
 * inserted is completed by its own execution — including a failed or
 * cancelled one. Without a context (`begin` threw, or its answer was lost
 * to a cancellation after its receipt committed), `record` rebuilds the run
 * key from this workflow's run id. An execution that is TERMINATED never
 * reaches `finally`; the next "Sync now" reconciles its receipt (§5.6).
 *
 * Started by the API (`packages/api/modules/projects/lib/context-repository-sync-workflow.ts`,
 * MANUAL) and by the shared repository-sync poll and push webhook
 * (`activities/lib/context-sync-start.ts`, POLL / WEBHOOK, §11.1) by name
 * on `project-documents`, id `context-repository-sync-<projectId>`
 * (`contextRepositorySyncWorkflowId` in `@repo/instructions/workflow-ids`),
 * with `workflowIdConflictPolicy: "FAIL"`. Its activities run on
 * `fabric-worker` (`CONTEXT_SYNC_ACTIVITY_TASK_QUEUE`). An automatic run
 * that `begin` skips (automatic sync off or paused) inserts no receipt, so
 * `record` finds nothing to complete.
 *
 * Workflow sandbox: imports only pure modules (`../lib/context-sync-types`,
 * `../task-queues`), never a package barrel. No I/O, clock, randomness or
 * environment read here.
 */
import {
	ActivityCancellationType,
	ApplicationFailure,
	CancellationScope,
	isCancellation,
	proxyActivities,
	workflowInfo,
} from "@temporalio/workflow";
import type * as activities from "../activities";
import {
	CONTEXT_SYNC_BEGIN_MAX_ATTEMPTS,
	type ContextSyncFailureDetails,
	type ContextSyncWorkflowInput,
	isContextSyncErrorCode,
	NON_RETRYABLE_CONTEXT_SYNC_ERRORS,
	type ProjectContextSyncError,
	type RecordContextSyncRunInput,
	type RecordContextSyncRunResult,
} from "../lib/context-sync-types";
import { CONTEXT_SYNC_ACTIVITY_TASK_QUEUE } from "../task-queues";

const onSyncQueue = {
	taskQueue: CONTEXT_SYNC_ACTIVITY_TASK_QUEUE,
} as const;

const { beginContextRepositorySyncRun } = proxyActivities<typeof activities>({
	...onSyncQueue,
	// Up to three read/describe/lock passes: 20 s of describes and one
	// 30-second transaction each.
	startToCloseTimeout: "3 minutes",
	// `begin` commits its receipt and then returns. Under the SDK default
	// (TRY_CANCEL) a cancelled workflow could reach `record` while `begin`
	// is still running, before its receipt is visible, and leave it
	// unfinished. WAIT_CANCELLATION_COMPLETED holds the cancellation until
	// `begin` has actually finished; it never heartbeats, so that is its own
	// completion, bounded by startToClose.
	cancellationType: ActivityCancellationType.WAIT_CANCELLATION_COMPLETED,
	retry: {
		initialInterval: "1s",
		maximumInterval: "30s",
		backoffCoefficient: 2,
		// `begin` reads the same constant: on its last attempt a predecessor
		// it cannot describe is refused (RUN_IN_PROGRESS, with a receipt)
		// instead of retried.
		maximumAttempts: CONTEXT_SYNC_BEGIN_MAX_ATTEMPTS,
	},
});

const { syncContextTreeFromRepository } = proxyActivities<typeof activities>({
	...onSyncQueue,
	startToCloseTimeout: "20 minutes",
	heartbeatTimeout: "60 seconds",
	// `record` (nonCancellable) must not race this activity's own fenced
	// writes: hold the cancellation until the activity has actually stopped.
	cancellationType: ActivityCancellationType.WAIT_CANCELLATION_COMPLETED,
	retry: {
		initialInterval: "2s",
		maximumInterval: "30s",
		backoffCoefficient: 2,
		// §5.2: up to three retries on CLONE_FAILED, INTEGRATION_UNAVAILABLE
		// and STORE_FAILED; every other typed failure is final.
		maximumAttempts: 4,
		nonRetryableErrorTypes: [...NON_RETRYABLE_CONTEXT_SYNC_ERRORS],
	},
});

const { recordContextRepositorySyncRun } = proxyActivities<typeof activities>({
	...onSyncQueue,
	startToCloseTimeout: "2 minutes",
	retry: {
		initialInterval: "1s",
		maximumInterval: "1 minute",
		backoffCoefficient: 2,
		maximumAttempts: 10,
	},
});

export async function projectContextRepositorySyncWorkflow(
	input: ContextSyncWorkflowInput,
): Promise<RecordContextSyncRunResult> {
	const state: RecordContextSyncRunInput = {
		projectId: input.projectId,
		organizationId: input.organizationId,
		trigger: input.trigger,
		workflowRunId: workflowInfo().runId,
		context: null,
		error: null,
		cancelled: false,
		commitSha: null,
	};
	let result: RecordContextSyncRunResult = {
		recorded: false,
		status: null,
		error: null,
	};
	try {
		await runSync(input, state);
	} catch (error) {
		if (isCancellation(error)) {
			// Not a typed failure: `record` completes the run as stopped.
			state.cancelled = true;
		}
		throw error;
	} finally {
		result = await CancellationScope.nonCancellable(() =>
			recordContextRepositorySyncRun(state),
		);
	}
	return result;
}

async function runSync(
	input: ContextSyncWorkflowInput,
	state: RecordContextSyncRunInput,
): Promise<void> {
	let begun: Awaited<ReturnType<typeof beginContextRepositorySyncRun>>;
	try {
		begun = await beginContextRepositorySyncRun({
			...input,
			workflowRunId: state.workflowRunId,
		});
	} catch (error) {
		if (!isCancellation(error)) {
			// `begin` refuses by value; a throw is operational (its retries
			// are spent). Tell `record`, then fail the workflow.
			state.error = typedFailure(error, "STORE_FAILED").code;
		}
		throw error;
	}
	if (!begun.ok) {
		state.context = begun.context ?? null;
		state.error = begun.error;
		return;
	}
	state.context = begun.context;
	try {
		const synced = await syncContextTreeFromRepository(begun.context);
		state.commitSha = synced.commitSha;
	} catch (error) {
		if (isCancellation(error)) {
			// Never recorded as a sync failure (not CLONE_FAILED): rethrown,
			// and `record` completes the run as stopped.
			throw error;
		}
		const failure = typedFailure(error, "CLONE_FAILED");
		state.error = failure.code;
		state.commitSha = failure.details.commitSha ?? null;
	}
}

/**
 * The typed failure, read from the innermost `ApplicationFailure` of the
 * `ActivityFailure` chain. Anything untyped (a retry exhausted on a thrown
 * TypeError, a timeout) is the fallback: a failed fetch for the sync, a
 * store failure for `begin`.
 */
function typedFailure(
	error: unknown,
	fallback: ProjectContextSyncError,
): { code: ProjectContextSyncError; details: ContextSyncFailureDetails } {
	let current: unknown = error;
	for (let depth = 0; depth < 10 && current instanceof Error; depth++) {
		if (
			current instanceof ApplicationFailure &&
			isContextSyncErrorCode(current.type)
		) {
			const first = current.details?.[0];
			const details =
				first !== null && typeof first === "object"
					? (first as ContextSyncFailureDetails)
					: {};
			return { code: current.type, details };
		}
		current = current.cause;
	}
	return { code: fallback, details: {} };
}
