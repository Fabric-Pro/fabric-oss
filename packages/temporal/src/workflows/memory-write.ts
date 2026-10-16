/**
 * Living Memory write: one workflow per receipt (ADR-022).
 *
 * Id `memory-write-<writeId>` (`memoryWriteWorkflowId`), type
 * `memoryWriteWorkflow`, on `project-instructions` (the queue the Coding
 * Instructions direct commit workflow uses); its activities run on
 * `fabric-worker`, the worker image that has git. The API starts it right after
 * it stores the receipt, and a repeated start for the same receipt finds the
 * open run by its id.
 *
 * It does three things in order, and none of the Coding Instructions machinery
 * (no snapshots, retention, caps, member branches or settlement):
 *
 * 1. `runMemoryWrite`: ONE activity that owns every read of the repository and
 *    every git write. It re-checks the target, the sync, the project and the
 *    member live, verifies the staged bytes, checks the tip (every path or
 *    none: the batch is atomic), then pushes one commit or opens one pull
 *    request. It answers how the write ended; it never writes the receipt.
 * 2. `recordMemoryWriteOutcome`: settles the receipt with that outcome and
 *    writes the audit row. Retried for a long time (`MEMORY_WRITE_RECORD_RETRY`):
 *    a commit on the branch cannot be un-pushed, so the receipt must not stay
 *    pending because the database was briefly unreachable. A record that gives
 *    up (its attempts are spent, or the write is refused for good) is reported,
 *    and the receipt is marked `FAILED SETTLE_FAILED` (`reportMemoryWriteSettleFailed`),
 *    never left pending. A write step that fails for good (its attempts are
 *    spent, or the worker was lost) is recorded `FAILED UNEXPECTED` the same way.
 * 3. After a COMMITTED outcome, `startMemoryWriteSync` asks the Living Memory
 *    sync to take the new head. A kick that fails is not a write failure: the
 *    poll or the push webhook takes the head anyway.
 *
 * A pull request has no watcher: once it is merged, the existing Living Memory
 * poll or webhook ingests it like any other change.
 *
 * Imports only the SDK, the pure vocabulary, the task-queue constant and
 * type-only activity signatures, as the workflow sandbox requires.
 */
import { isCancellation, proxyActivities } from "@temporalio/workflow";
import type * as memoryWriteActivities from "../activities/memory-write";
import type { MemoryWriteOutcome } from "../lib/memory-write/outcome";
import {
	MEMORY_WRITE_ACTIVITY_TIMEOUTS,
	MEMORY_WRITE_MAX_ATTEMPTS,
	MEMORY_WRITE_RECORD_RETRY,
	MEMORY_WRITE_REPORT_RETRY,
	MEMORY_WRITE_SYNC_KICK_RETRY,
	type MemoryWriteStepResult,
	type MemoryWriteWorkflowInput,
	type MemoryWriteWorkflowResult,
} from "../lib/memory-write-types";
import { INSTRUCTION_SYNC_ACTIVITY_TASK_QUEUE } from "../task-queues";

/**
 * Covers timeouts and worker loss. The git-writing activity hands its own
 * failures back as the write's outcome on its last attempt, so a retry only
 * follows a crash or a fault worth another attempt.
 */
const RUN_RETRY = {
	maximumAttempts: MEMORY_WRITE_MAX_ATTEMPTS,
	initialInterval: "10 seconds",
	backoffCoefficient: 2,
} as const;

// Destructured, not read off the proxy object, so the activity-registration
// parity guard (`workflows/__tests__/activity-registration-parity.test.ts`)
// can see each name statically.
const { runMemoryWrite } = proxyActivities<typeof memoryWriteActivities>({
	taskQueue: INSTRUCTION_SYNC_ACTIVITY_TASK_QUEUE,
	startToCloseTimeout: MEMORY_WRITE_ACTIVITY_TIMEOUTS.run.startToCloseMs,
	heartbeatTimeout: MEMORY_WRITE_ACTIVITY_TIMEOUTS.run.heartbeatMs,
	retry: RUN_RETRY,
});
const { recordMemoryWriteOutcome } = proxyActivities<
	typeof memoryWriteActivities
>({
	taskQueue: INSTRUCTION_SYNC_ACTIVITY_TASK_QUEUE,
	startToCloseTimeout: MEMORY_WRITE_ACTIVITY_TIMEOUTS.record.startToCloseMs,
	retry: MEMORY_WRITE_RECORD_RETRY,
});
// The report that follows a record that gave up is best effort.
const { reportMemoryWriteSettleFailed } = proxyActivities<
	typeof memoryWriteActivities
>({
	taskQueue: INSTRUCTION_SYNC_ACTIVITY_TASK_QUEUE,
	startToCloseTimeout: MEMORY_WRITE_ACTIVITY_TIMEOUTS.record.startToCloseMs,
	retry: MEMORY_WRITE_REPORT_RETRY,
});
const { startMemoryWriteSync } = proxyActivities<typeof memoryWriteActivities>({
	taskQueue: INSTRUCTION_SYNC_ACTIVITY_TASK_QUEUE,
	startToCloseTimeout: MEMORY_WRITE_ACTIVITY_TIMEOUTS.syncKick.startToCloseMs,
	retry: MEMORY_WRITE_SYNC_KICK_RETRY,
});

/** The outcome recorded for a write step that failed for good, with no answer of its own. */
const WRITE_STEP_LOST: MemoryWriteOutcome = {
	status: "FAILED",
	code: "UNEXPECTED",
	retryable: false,
};

/**
 * Runs `step`, which records something that is owed, and answers with what it
 * recorded or, when the step gave up, runs `report` (best effort: a report that
 * fails too changes nothing) and answers `gave_up`. Never fails the workflow,
 * bar a cancellation.
 */
async function recordOrReport<T>(
	step: () => Promise<T>,
	report: () => Promise<void>,
): Promise<T | { kind: "gave_up" }> {
	try {
		return await step();
	} catch (error) {
		if (isCancellation(error)) {
			throw error;
		}
	}
	try {
		await report();
	} catch (error) {
		if (isCancellation(error)) {
			throw error;
		}
	}
	return { kind: "gave_up" };
}

/** The commit or branch head an outcome names, when one reached the repository. */
function shaOf(outcome: MemoryWriteOutcome): string | null {
	return outcome.status === "COMMITTED" || outcome.status === "PULL_REQUEST"
		? outcome.sha
		: null;
}

export async function memoryWriteWorkflow(
	input: MemoryWriteWorkflowInput,
): Promise<MemoryWriteWorkflowResult> {
	const ids = {
		writeId: input.writeId,
		projectId: input.projectId,
		organizationId: input.organizationId,
	};
	let step: MemoryWriteStepResult;
	try {
		step = await runMemoryWrite(ids);
	} catch (error) {
		if (isCancellation(error)) {
			throw error;
		}
		// Its attempts are spent, or the worker was lost: nothing is known to be
		// on the repository, and the receipt is not left pending.
		step = { kind: "outcome", outcome: WRITE_STEP_LOST };
	}
	if (step.kind === "stopped") {
		return { kind: "stopped" };
	}

	const { outcome } = step;
	const recorded = await recordOrReport(
		() => recordMemoryWriteOutcome({ ...ids, outcome }),
		() => reportMemoryWriteSettleFailed({ ...ids, sha: shaOf(outcome) }),
	);
	if (recorded.kind === "gave_up") {
		return { kind: "settled", status: "FAILED" };
	}

	// The commit is recorded; the sync taking its head is a courtesy that spares
	// the poll's wait, so its failure is not the write's.
	if (recorded.status === "COMMITTED" && outcome.status === "COMMITTED") {
		try {
			await startMemoryWriteSync({ ...ids, sha: outcome.sha });
		} catch (error) {
			if (isCancellation(error)) {
				throw error;
			}
		}
	}
	return { kind: "settled", status: recorded.status };
}
