/**
 * Knowledge hub: debounced regeneration of a topic's living document.
 *
 * Started with the workflow id `knowledge-summary-<topicId>` and the
 * USE_EXISTING conflict policy, so a burst of entries on one topic shares one
 * run. The run waits for the burst to settle, summarizes, and summarizes once
 * more when entries arrived while it worked.
 */

import { proxyActivities, sleep } from "@temporalio/workflow";
import type {
	generateKnowledgeTopicSummaryActivity as GenerateFn,
	KnowledgeTopicSummaryInput,
	KnowledgeTopicSummaryResult,
} from "../activities/knowledge-topic-summary";
import { AI_NON_RETRYABLE_ERROR_TYPES } from "./ai-non-retryable-errors";

const { generateKnowledgeTopicSummaryActivity } = proxyActivities<{
	generateKnowledgeTopicSummaryActivity: typeof GenerateFn;
}>({
	startToCloseTimeout: "5 minutes",
	retry: {
		maximumAttempts: 3,
		initialInterval: "10 seconds",
		nonRetryableErrorTypes: [...AI_NON_RETRYABLE_ERROR_TYPES],
	},
});

/** Quiet period before summarizing, so several entries land in one run. */
const DEBOUNCE = "20 seconds";
/** Upper bound on back-to-back runs when entries keep arriving. */
const MAX_PASSES = 3;

export async function knowledgeTopicSummaryWorkflow(
	input: KnowledgeTopicSummaryInput,
): Promise<KnowledgeTopicSummaryResult> {
	let result: KnowledgeTopicSummaryResult = {
		summaryId: null,
		status: "SKIPPED",
		stale: false,
	};
	for (let pass = 0; pass < MAX_PASSES; pass++) {
		await sleep(DEBOUNCE);
		result = await generateKnowledgeTopicSummaryActivity(input);
		if (!result.stale) {
			break;
		}
	}
	return result;
}

export const KNOWLEDGE_TOPIC_SUMMARY_WORKFLOW = "knowledgeTopicSummaryWorkflow";

export function knowledgeTopicSummaryWorkflowId(topicId: string): string {
	return `knowledge-summary-${topicId}`;
}
