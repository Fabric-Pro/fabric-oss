/**
 * Queues the run a member asked for by changing what a repository sync syncs
 * while another run was still open (Coding Instructions and Living Memory
 * alike).
 *
 * A configure that changes the selection fences the open run, and "Sync now"
 * is refused for as long as it stays open, so without this the new selection
 * would sync only if someone pressed the button again, or if automatic sync
 * happened to be on. The workflow it starts waits for the sync's execution to
 * close and then starts the next run under the sync's own id and conflict
 * policy (`projectRepositorySyncFollowUpWorkflow`), so it survives the tab
 * closing.
 *
 * Its own id per subject and project, started with `TERMINATE_EXISTING`: a
 * second change while one is waiting replaces it, so the newest member's
 * choice is the one the run acts for and there is never more than one waiter.
 *
 * A failure to queue never fails the configure that triggered it: the
 * configuration is saved either way. It answers `false` and the caller says
 * nothing is queued, which leaves the person with today's "Sync now".
 */
import {
	type RepositorySyncFollowUpSubject,
	repositorySyncFollowUpWorkflowId,
} from "@repo/instructions";
import { logger } from "@repo/logs";
import { getTemporalClient } from "@repo/temporal";
import { withCorrelationMemo } from "../../../lib/temporal-correlation";

export async function queueRepositorySyncFollowUp(input: {
	subject: RepositorySyncFollowUpSubject;
	projectId: string;
	organizationId: string;
	requesterUserId: string;
}): Promise<boolean> {
	try {
		const client = await getTemporalClient();
		await client.workflow.start(
			"projectRepositorySyncFollowUpWorkflow",
			withCorrelationMemo({
				taskQueue: "fabric-worker",
				workflowId: repositorySyncFollowUpWorkflowId(
					input.subject,
					input.projectId,
				),
				workflowIdConflictPolicy: "TERMINATE_EXISTING",
				args: [input],
			}),
		);
		return true;
	} catch (error) {
		logger.warn(
			{
				event: "repository_sync.follow_up_not_queued",
				subject: input.subject,
				projectId: input.projectId,
				organizationId: input.organizationId,
				failure: error instanceof Error ? error.name : "unknown",
			},
			"[RepositorySync] Could not queue the follow-up run",
		);
		return false;
	}
}
