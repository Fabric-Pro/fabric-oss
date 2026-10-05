/**
 * Coding Instructions revert of one commit on a repository-backed project's
 * synced branch (Fizzy #2878 §10).
 *
 * Id `project-instruction-revert-commit-<projectId>`
 * (`instructionRevertCommitWorkflowId`: one open revert per project, started
 * with `workflowIdConflictPolicy: "FAIL"`), type
 * `projectInstructionRevertCommitWorkflow`, on `project-instructions`; its
 * activities run on `fabric-worker`: the revert, then, for a commit the branch
 * holds, the audit row (retried for up to a hundred attempts) and the
 * confirming sync run (retried while another run is open, for at most thirty
 * minutes). The API starts it with a 24 hour execution timeout, and waits for
 * the result, which is the answer to the member's click: the revert's own
 * typed outcome, or a typed failure once the activity's attempts are spent. A
 * revert has no snapshot row, so the result is the only record besides the
 * commit; an audit record that gives up is reported with one error log
 * (`reportRevertRecordFailed`) and does not change the answer, because the
 * branch holds the revert.
 *
 * `requestId` is the commit's `Fabric-Commit` trailer, so an attempt that lost
 * its acknowledgement finds the commit it pushed instead of pushing a second.
 *
 * Imports only the SDK, the pure vocabulary, the task-queue constant and
 * type-only activity signatures, as the workflow sandbox requires.
 */
import { isCancellation, proxyActivities } from "@temporalio/workflow";
import type * as directCommitActivities from "../activities/instruction-direct-commit";
import {
	DIRECT_COMMIT_ACTIVITY_TIMEOUTS,
	DIRECT_COMMIT_MAX_ATTEMPTS,
	RECORD_PUSHED_RETRY,
	RECORD_REPORT_RETRY,
	REVERT_ACTIVITY_TIMEOUTS,
	type RevertCommitWorkflowInput,
	type RevertCommitWorkflowResult,
} from "../lib/instruction-direct-commit-types";
import { INSTRUCTION_SYNC_ACTIVITY_TASK_QUEUE } from "../task-queues";
import { confirmPushedHead } from "./instruction-confirming-sync";

// Destructured, not read off the proxy object, so the activity-registration
// parity guard can see the name statically.
const { revertCommitOnSyncedBranch } = proxyActivities<
	typeof directCommitActivities
>({
	taskQueue: INSTRUCTION_SYNC_ACTIVITY_TASK_QUEUE,
	startToCloseTimeout: REVERT_ACTIVITY_TIMEOUTS.revert.startToCloseMs,
	heartbeatTimeout: REVERT_ACTIVITY_TIMEOUTS.revert.heartbeatMs,
	retry: {
		maximumAttempts: DIRECT_COMMIT_MAX_ATTEMPTS,
		initialInterval: "10 seconds",
		backoffCoefficient: 2,
	},
} as const);

// The audit row of a revert the branch already holds: retried for a hundred
// attempts as a direct commit's outcome is, and ended at once by a fault no
// retry can fix.
const { recordRevertedCommit } = proxyActivities<typeof directCommitActivities>(
	{
		taskQueue: INSTRUCTION_SYNC_ACTIVITY_TASK_QUEUE,
		startToCloseTimeout:
			DIRECT_COMMIT_ACTIVITY_TIMEOUTS.record.startToCloseMs,
		retry: RECORD_PUSHED_RETRY,
	},
);

// The report that follows a record that gave up is best effort.
const { reportRevertRecordFailed } = proxyActivities<
	typeof directCommitActivities
>({
	taskQueue: INSTRUCTION_SYNC_ACTIVITY_TASK_QUEUE,
	startToCloseTimeout: DIRECT_COMMIT_ACTIVITY_TIMEOUTS.record.startToCloseMs,
	retry: RECORD_REPORT_RETRY,
});

export async function projectInstructionRevertCommitWorkflow(
	input: RevertCommitWorkflowInput,
): Promise<RevertCommitWorkflowResult> {
	const result = await revertCommitOnSyncedBranch(input);
	if (result.kind === "reverted") {
		const reverted = {
			sha: result.sha,
			ref: result.ref,
			fileCount: result.fileCount,
		};
		try {
			const confirm = await recordRevertedCommit(input, reverted);
			if (confirm !== null) {
				await confirmPushedHead(confirm);
			}
		} catch (error) {
			if (isCancellation(error)) {
				throw error;
			}
			try {
				await reportRevertRecordFailed(input, { sha: reverted.sha });
			} catch (reportError) {
				if (isCancellation(reportError)) {
					throw reportError;
				}
			}
		}
	}
	return result;
}
