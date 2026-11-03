/**
 * Starts (or joins) the debounced summary run for a knowledge topic.
 *
 * Kept free of workflow imports so `@repo/api` can call it without pulling the
 * workflow bundle in. A run already in progress for the topic is reused
 * (USE_EXISTING): it summarizes again when it sees entries newer than its
 * summary.
 */

import type { Client } from "@temporalio/client";

const KNOWLEDGE_TOPIC_SUMMARY_WORKFLOW = "knowledgeTopicSummaryWorkflow";
const KNOWLEDGE_TOPIC_SUMMARY_TASK_QUEUE = "project-documents";

export interface KnowledgeSummaryStartTarget {
	projectId: string;
	topicId: string;
}

export async function startKnowledgeTopicSummaryWorkflow(
	client: Client,
	target: KnowledgeSummaryStartTarget,
	options: {
		decorateStartOptions?: <T extends object>(options: T) => T;
	} = {},
): Promise<{ workflowId: string }> {
	const workflowId = `knowledge-summary-${target.topicId}`;
	const startOptions = {
		taskQueue: KNOWLEDGE_TOPIC_SUMMARY_TASK_QUEUE,
		workflowId,
		args: [target],
		workflowIdConflictPolicy: "USE_EXISTING" as const,
	};
	await client.workflow.start(
		KNOWLEDGE_TOPIC_SUMMARY_WORKFLOW,
		options.decorateStartOptions
			? options.decorateStartOptions(startOptions)
			: startOptions,
	);
	return { workflowId };
}
