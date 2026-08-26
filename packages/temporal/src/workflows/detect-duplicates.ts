/**
 * Fire-and-forget workflow that runs automatic semantic duplicate detection
 * over newly-created stories in the background.
 *
 * Started (not awaited) by `triggerDuplicateDetection` from the AI create
 * paths — AI Update (`applyBacklogChanges`), Teams/Slack proposal approval, and
 * the `fabric_create_story` agent tool. Moving detection here (vs running it
 * inline in the create request) means:
 *   1. the create/approval returns immediately (detection never blocks it), and
 *   2. the single detection activity is RETRIED with backoff, so a transient
 *      embedding/LLM rate-limit error under burst load no longer silently skips
 *      detection (the bug surfaced by approving many channel proposals at once).
 *
 * Intentionally trivial: one retried activity call, no signals/queries.
 */

import { proxyActivities } from "@temporalio/workflow";
import type * as activities from "../activities";

const { detectDuplicateStoriesActivity } = proxyActivities<typeof activities>({
	startToCloseTimeout: "5m",
	retry: {
		initialInterval: "10s",
		backoffCoefficient: 2,
		maximumAttempts: 6,
		maximumInterval: "2m",
	},
});

export interface DetectDuplicatesWorkflowInput {
	projectId: string;
	userId: string;
	organizationId?: string | null;
	/** IDs of the just-created stories to check against the existing backlog. */
	targetStoryIds: string[];
}

export interface DetectDuplicatesWorkflowOutput {
	scanned: number;
	candidates: number;
	confirmed: number;
	truncated: number;
}

export async function detectDuplicatesWorkflow(
	input: DetectDuplicatesWorkflowInput,
): Promise<DetectDuplicatesWorkflowOutput> {
	return detectDuplicateStoriesActivity(input);
}
