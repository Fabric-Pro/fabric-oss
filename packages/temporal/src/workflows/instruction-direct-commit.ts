/**
 * Coding Instructions direct commit: one workflow per `REPOSITORY_COMMIT`
 * snapshot (Fizzy #2878 §10).
 *
 * Id `project-instruction-direct-commit-<snapshotId>`
 * (`instructionDirectCommitWorkflowId`), type
 * `projectInstructionDirectCommitWorkflow`, on `project-instructions`; its
 * activities run on `fabric-worker`. The API starts it BEFORE it starts the
 * snapshot's validation, so a failed start leaves nothing to commit and the
 * row is closed out on the spot.
 *
 * It does two things in order. It waits for the snapshot's own verify → scan →
 * promote workflow to reach READY, sleeping 2, 4, 8, 15, then 30 s between
 * answers, for at most 30 minutes (the wait is counted in the workflow, which
 * never reads a clock). Then it runs ONE activity, `commitToSyncedBranch`,
 * which owns every git write: it pushes one commit, or says why not. The
 * secret scan has therefore decided every byte before anything is written to
 * the repository.
 *
 * What the commit step decided is recorded by the workflow, with activities
 * that are retried for up to a hundred attempts (`RECORD_PUSHED_RETRY`): a
 * commit that was pushed (`recordPushedDirectCommit`) cannot be un-pushed, and
 * an outcome that wrote nothing (`recordDirectCommitSettlement`) is as owed,
 * so neither is left pending because the database was briefly unreachable. A
 * record that gives up (its attempts are spent, or the write is refused for
 * good) is reported, and the row is marked `failed SETTLE_FAILED`
 * (`reportDirectCommitSettleFailed`), never left pending. A commit step that
 * fails for good (its attempts are spent, or the worker was lost) is recorded
 * `failed UNEXPECTED` the same way. Once a pushed commit is recorded the
 * workflow asks the sync to take the new head (`confirmPushedHead`, retried
 * while another run is open, for at most thirty minutes), so the published
 * version and the agents follow the branch. The API starts the workflow with
 * a 24 hour execution timeout: a row that is still pending then has nothing
 * behind it, and the reaper closes it (`STALE`).
 *
 * A snapshot the scan REJECTED ends the workflow without recording an outcome:
 * its status and findings are the verdict.
 *
 * Imports only the SDK, the pure vocabulary, the task-queue constant and
 * type-only activity signatures, as the workflow sandbox requires.
 */
import { isCancellation, proxyActivities, sleep } from "@temporalio/workflow";
import type * as directCommitActivities from "../activities/instruction-direct-commit";
import {
	type CommitToSyncedBranchResult,
	DIRECT_COMMIT_ACTIVITY_TIMEOUTS,
	DIRECT_COMMIT_MAX_ATTEMPTS,
	DIRECT_COMMIT_READINESS_SLEEPS_S,
	DIRECT_COMMIT_VALIDATION_WAIT_MS,
	type DirectCommitWorkflowInput,
	type DirectCommitWorkflowResult,
	RECORD_PUSHED_RETRY,
	RECORD_REPORT_RETRY,
	type UnrecordedCommitOutcome,
} from "../lib/instruction-direct-commit-types";
import { INSTRUCTION_SYNC_ACTIVITY_TASK_QUEUE } from "../task-queues";
import { confirmPushedHead } from "./instruction-confirming-sync";

/**
 * Covers timeouts and worker loss. The git-writing activity records its own
 * failures on its last attempt, so a retry only follows a crash or a fault
 * worth another attempt.
 */
const RETRY = {
	maximumAttempts: DIRECT_COMMIT_MAX_ATTEMPTS,
	initialInterval: "10 seconds",
	backoffCoefficient: 2,
} as const;

function options(t: { startToCloseMs: number; heartbeatMs?: number }) {
	return {
		taskQueue: INSTRUCTION_SYNC_ACTIVITY_TASK_QUEUE,
		startToCloseTimeout: t.startToCloseMs,
		...(t.heartbeatMs !== undefined
			? { heartbeatTimeout: t.heartbeatMs }
			: {}),
		retry: RETRY,
	};
}

// Destructured, not read off the proxy object, so the activity-registration
// parity guard (`workflows/__tests__/activity-registration-parity.test.ts`)
// can see each name statically.
const { checkDirectCommitReadiness } = proxyActivities<
	typeof directCommitActivities
>(options(DIRECT_COMMIT_ACTIVITY_TIMEOUTS.readiness));
const { commitToSyncedBranch } = proxyActivities<typeof directCommitActivities>(
	options(DIRECT_COMMIT_ACTIVITY_TIMEOUTS.commit),
);
// Recording what the commit step decided is retried for a hundred attempts: a
// commit already on the branch cannot be un-pushed, so giving up early would
// leave the row pending, and an outcome that wrote nothing is as owed. A fault
// no retry can fix ends the record at once (`nonRetryableErrorTypes`).
const { recordPushedDirectCommit, recordDirectCommitSettlement } =
	proxyActivities<typeof directCommitActivities>({
		taskQueue: INSTRUCTION_SYNC_ACTIVITY_TASK_QUEUE,
		startToCloseTimeout:
			DIRECT_COMMIT_ACTIVITY_TIMEOUTS.record.startToCloseMs,
		retry: RECORD_PUSHED_RETRY,
	});
// The report that follows a record that gave up is best effort.
const { reportDirectCommitSettleFailed } = proxyActivities<
	typeof directCommitActivities
>({
	taskQueue: INSTRUCTION_SYNC_ACTIVITY_TASK_QUEUE,
	startToCloseTimeout: DIRECT_COMMIT_ACTIVITY_TIMEOUTS.record.startToCloseMs,
	retry: RECORD_REPORT_RETRY,
});

/** The outcome recorded for a commit step that failed for good, with no answer of its own. */
const COMMIT_STEP_LOST: UnrecordedCommitOutcome = {
	outcome: "failed",
	code: "UNEXPECTED",
	retryable: false,
};

/**
 * Runs `step`, which records something that is owed, and answers with what it
 * recorded or, when the step gave up, runs `report` (best effort: a report
 * that fails too changes nothing) and answers `gave_up`. Never fails the
 * workflow, bar a cancellation.
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

/** The sleep after `n` answers that were not `ready`: 2, 4, 8, 15, then 30 s. */
export function directCommitReadinessSleepMs(n: number): number {
	const last = DIRECT_COMMIT_READINESS_SLEEPS_S.length - 1;
	return (DIRECT_COMMIT_READINESS_SLEEPS_S[Math.min(n, last)] ?? 30) * 1000;
}

export async function projectInstructionDirectCommitWorkflow(
	input: DirectCommitWorkflowInput,
): Promise<DirectCommitWorkflowResult> {
	const ids = {
		snapshotId: input.snapshotId,
		organizationId: input.organizationId,
	};
	let waitedMs = 0;
	let answers = 0;
	for (;;) {
		const readiness = await checkDirectCommitReadiness({
			...ids,
			deadlineReached: waitedMs >= DIRECT_COMMIT_VALIDATION_WAIT_MS,
		});
		if (readiness.kind === "stop") {
			return { kind: "stopped" };
		}
		if (readiness.kind === "pending") {
			const ms = directCommitReadinessSleepMs(answers++);
			await sleep(ms);
			waitedMs += ms;
			continue;
		}
		let result: CommitToSyncedBranchResult;
		try {
			result = await commitToSyncedBranch(ids);
		} catch (error) {
			if (isCancellation(error)) {
				throw error;
			}
			// Its attempts are spent, or the worker was lost: nothing is known
			// to be on the branch, and the row is not left pending.
			result = { kind: "outcome", outcome: COMMIT_STEP_LOST };
		}
		if (result.kind === "settled") {
			return { kind: "settled", outcome: result.outcome };
		}
		if (result.kind === "outcome") {
			const { outcome } = result;
			const recorded = await recordOrReport(
				() => recordDirectCommitSettlement({ ...ids, outcome }),
				() => reportDirectCommitSettleFailed({ ...ids, sha: null }),
			);
			return {
				kind: "settled",
				outcome:
					recorded.kind === "settled" ? recorded.outcome : "failed",
			};
		}
		if (result.kind === "pushed") {
			const { sha } = result;
			const recorded = await recordOrReport(
				() => recordPushedDirectCommit({ ...ids, sha }),
				() => reportDirectCommitSettleFailed({ ...ids, sha }),
			);
			if (recorded.kind === "gave_up") {
				return { kind: "settled", outcome: "failed" };
			}
			await confirmPushedHead(recorded.confirm);
			return { kind: "settled", outcome: recorded.outcome };
		}
		if (result.kind === "stopped") {
			return { kind: "stopped" };
		}
		// `not_ready`: the row left READY between the two answers; wait again.
		const ms = directCommitReadinessSleepMs(answers++);
		await sleep(ms);
		waitedMs += ms;
	}
}
