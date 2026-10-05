/**
 * The step both commit workflows end with (Fizzy #2878 §10): ask the sync to
 * take the head a commit of ours just put on the branch, so the published
 * version, the agents and the Files tab follow it.
 *
 * The sync is one workflow per project. A run that is open when the commit is
 * pushed may have read the branch before it, and a start that is refused for
 * that reason would leave the head unpublished until the next poll, so the
 * activity fails with a retryable error while a run is open and this step
 * retries it with a backoff, for at most thirty minutes
 * (`CONFIRMING_SYNC_RETRY`). The commit is already recorded by then; a start
 * that never lands is left to the next poll or webhook, which takes the head
 * anyway, so this step never fails its workflow.
 *
 * Imports only the SDK, the pure vocabulary, the task-queue constant and
 * type-only activity signatures, as the workflow sandbox requires.
 */
import { isCancellation, proxyActivities } from "@temporalio/workflow";
import type * as directCommitActivities from "../activities/instruction-direct-commit";
import {
	CONFIRMING_SYNC_ACTIVITY_TIMEOUTS,
	CONFIRMING_SYNC_RETRY,
	type ConfirmingSyncInput,
} from "../lib/instruction-direct-commit-types";
import { INSTRUCTION_SYNC_ACTIVITY_TASK_QUEUE } from "../task-queues";

// Destructured, not read off the proxy object, so the activity-registration
// parity guard can see the name statically.
const { startConfirmingInstructionSync } = proxyActivities<
	typeof directCommitActivities
>({
	taskQueue: INSTRUCTION_SYNC_ACTIVITY_TASK_QUEUE,
	startToCloseTimeout: CONFIRMING_SYNC_ACTIVITY_TIMEOUTS.startToCloseMs,
	scheduleToCloseTimeout: CONFIRMING_SYNC_ACTIVITY_TIMEOUTS.scheduleToCloseMs,
	retry: CONFIRMING_SYNC_RETRY,
});

export async function confirmPushedHead(
	confirm: ConfirmingSyncInput,
): Promise<void> {
	try {
		await startConfirmingInstructionSync(confirm);
	} catch (error) {
		if (isCancellation(error)) {
			throw error;
		}
	}
}
