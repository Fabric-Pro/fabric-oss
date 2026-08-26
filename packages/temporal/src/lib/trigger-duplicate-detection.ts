/**
 * Fire-and-forget client trigger for the `detectDuplicates` workflow.
 *
 * Replaces the previous inline `await detectAndFlagDuplicateStories(...)` at the
 * three AI create paths (AI Update apply, Teams/Slack proposal approval,
 * `fabric_create_story`). Starting a durable, retried workflow instead of
 * running detection inline means the create/approval returns immediately AND
 * the detection activity is retried with backoff — so transient embedding/LLM
 * rate-limit errors under burst load no longer silently skip detection.
 *
 * Never throws: failing to enqueue is logged and swallowed, exactly like the
 * old inline guard, so it can never break the create flow that calls it.
 */

import { logger } from "@repo/logs";
import { getTemporalClient, isTemporalAvailable } from "../client";

const TASK_QUEUE = "ai-chat";

export interface TriggerDuplicateDetectionParams {
	projectId: string;
	userId: string;
	organizationId?: string | null;
	/** IDs of the just-created stories to check against the existing backlog. */
	targetStoryIds: string[];
}

export async function triggerDuplicateDetection(
	params: TriggerDuplicateDetectionParams,
): Promise<{ workflowId: string } | null> {
	const { projectId, userId, organizationId, targetStoryIds } = params;

	const uniqueTargetIds = Array.from(new Set(targetStoryIds));
	if (uniqueTargetIds.length === 0) {
		return null;
	}

	try {
		if (!(await isTemporalAvailable())) {
			logger.warn(
				"[Auto Dup Detect] Temporal unavailable — skipping detection enqueue",
				{ projectId },
			);
			return null;
		}

		const client = await getTemporalClient();
		const workflowId = `dup-detect-${projectId}-${Date.now()}`;
		const handle = await client.workflow.start("detectDuplicatesWorkflow", {
			taskQueue: TASK_QUEUE,
			workflowId,
			args: [
				{
					projectId,
					userId,
					organizationId: organizationId ?? null,
					targetStoryIds: uniqueTargetIds,
				},
			],
		});

		logger.info("[Auto Dup Detect] enqueued background detection", {
			projectId,
			workflowId: handle.workflowId,
			targets: uniqueTargetIds.length,
		});
		return { workflowId: handle.workflowId };
	} catch (err) {
		logger.warn(
			"[Auto Dup Detect] failed to enqueue detection workflow (non-blocking)",
			{
				projectId,
				err: err instanceof Error ? err.message : String(err),
			},
		);
		return null;
	}
}
