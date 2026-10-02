/**
 * The run a member asked for by changing what a repository sync syncs while
 * another run was still open.
 *
 * A configure that changes the selection fences the open run, which stops at
 * its next fence, and the dialog's own "Sync now" is refused for as long as it
 * is open. Nothing then started a run for the new selection, and with
 * automatic sync off nothing ever would. The API starts this workflow instead,
 * under an id of its own: it waits for the sync's execution to close, in
 * bounded steps, and then starts the next run under the sync's id with the
 * sync's own conflict policy (`FAIL`).
 *
 * It lives in the workflow engine rather than in the tab, so it survives the
 * member closing the page, a worker restart, and the API process that queued
 * it going away. It is race-safe by construction: the start is the sync's own,
 * so a second start (another member's "Sync now", the poll, a webhook) is
 * refused by Temporal and answered `already_running`, which is enough; a
 * second configure replaces this workflow (`TERMINATE_EXISTING`) and so
 * leaves one waiter, not two; and a run started twice would only be an
 * unchanged one.
 *
 * Deterministic: no clock, no I/O. The waits and the start are activities.
 * A new workflow type, so no history exists for it to replay against.
 */
import { proxyActivities } from "@temporalio/workflow";
import type * as activities from "../activities";
import {
	REPOSITORY_SYNC_FOLLOW_UP_MAX_WAITS,
	type RepositorySyncFollowUpInput,
	type RepositorySyncFollowUpOutcome,
} from "../lib/repository-sync-follow-up";

const { awaitRepositorySyncClosed } = proxyActivities<typeof activities>({
	// One wait is 55 s inside the attempt; the heartbeat keeps a dead worker
	// from holding the whole window.
	startToCloseTimeout: "2 minutes",
	heartbeatTimeout: "30 seconds",
	retry: {
		initialInterval: "2s",
		maximumInterval: "30s",
		backoffCoefficient: 2,
		maximumAttempts: 5,
	},
});

const { startQueuedRepositorySync } = proxyActivities<typeof activities>({
	startToCloseTimeout: "1 minute",
	retry: {
		initialInterval: "2s",
		maximumInterval: "30s",
		backoffCoefficient: 2,
		maximumAttempts: 5,
	},
});

export async function projectRepositorySyncFollowUpWorkflow(
	input: RepositorySyncFollowUpInput,
): Promise<{ outcome: RepositorySyncFollowUpOutcome | "still_running" }> {
	for (let wait = 0; wait < REPOSITORY_SYNC_FOLLOW_UP_MAX_WAITS; wait++) {
		const settled = await awaitRepositorySyncClosed({
			subject: input.subject,
			projectId: input.projectId,
		});
		if (settled.closed) {
			return startQueuedRepositorySync(input);
		}
	}
	return { outcome: "still_running" };
}
