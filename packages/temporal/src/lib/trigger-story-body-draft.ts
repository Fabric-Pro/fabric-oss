/**
 * Fire-and-forget client trigger that drafts a just-created work item's body
 * afterwards.
 *
 * A caller that must answer a person while it works (a voice meeting) creates
 * the item at once from the person's own words and has this write the full
 * body through the item's type template off the request path, with the same
 * workflow that rewrites a body after a type conversion. That workflow reads
 * the kind back off the stored row, snapshots the prior body as a version
 * before replacing it, and discards its draft if someone edited the item in
 * the meantime.
 *
 * Never throws: failing to enqueue leaves a valid item with the body it was
 * created with. The one exception is an Advisor chat turn's stop, as in
 * `triggerDuplicateDetection`.
 */

import { logger } from "@repo/logs";
import {
	rethrowIfDispatchStopped,
	throwIfDispatchStopped,
} from "@repo/utils/dispatch-guard";
import { getTemporalClient, isTemporalAvailable } from "../client";

const TASK_QUEUE = "ai-chat";
const ENTRY_POINT = "agentCreateDeferredDraft";

export interface TriggerStoryBodyDraftParams {
	storyId: string;
	projectId: string;
	userId: string;
	organizationId?: string | null;
	targetKind: "BUG" | "FEATURE";
}

export async function triggerStoryBodyDraft(
	params: TriggerStoryBodyDraftParams,
): Promise<{ workflowId: string } | null> {
	const { storyId, projectId, userId, organizationId, targetKind } = params;
	try {
		if (!(await isTemporalAvailable())) {
			logger.warn(
				"[Story Body Draft] Temporal unavailable — leaving the body as created",
				{ storyId },
			);
			return null;
		}
		const client = await getTemporalClient();
		throwIfDispatchStopped();
		const handle = await client.workflow.start(
			"regenerateBodyForKindWorkflow",
			{
				taskQueue: TASK_QUEUE,
				workflowId: `story-body-draft-${storyId}`,
				args: [
					{
						storyId,
						projectId,
						organizationId: organizationId ?? null,
						userId,
						targetKind,
						entryPoint: ENTRY_POINT,
					},
				],
			},
		);
		logger.info("[Story Body Draft] enqueued background drafting", {
			storyId,
			workflowId: handle.workflowId,
		});
		return { workflowId: handle.workflowId };
	} catch (error) {
		rethrowIfDispatchStopped(error);
		logger.warn(
			"[Story Body Draft] failed to enqueue drafting (non-blocking)",
			{
				storyId,
				error: error instanceof Error ? error.message : String(error),
			},
		);
		return null;
	}
}
