/**
 * Context Embedding Workflow
 *
 * A durable workflow for embedding project contexts (Notion pages, uploaded files, etc.)
 * into Qdrant for RAG retrieval. This workflow is triggered:
 * - When a Notion page is synced
 * - When a file is uploaded
 * - When any context with content is created
 *
 * Benefits of using Temporal:
 * - Automatic retries on transient failures (API errors, rate limits)
 * - Durability (survives server restarts)
 * - Visibility and monitoring
 * - Consistent error handling
 */

import { ApplicationFailure, proxyActivities } from "@temporalio/workflow";
import type * as activities from "../activities";

const { embedSingleContextActivity } = proxyActivities<typeof activities>({
	startToCloseTimeout: "5 minutes",
	heartbeatTimeout: "30 seconds",
	retry: {
		initialInterval: "1s",
		maximumInterval: "30s",
		backoffCoefficient: 2,
		maximumAttempts: 3,
	},
});

export interface ContextEmbeddingWorkflowInput {
	contextId: string;
	projectId: string;
	userId: string;
	organizationId?: string;
	/**
	 * The body to embed. Optional: omit it and the activity reads the content
	 * back from `contextId`. Callers with a body small enough to travel cheaply
	 * still pass it inline; a meeting transcript no longer does, because since
	 * Fizzy #2316 it is stored whole and an arbitrarily long one would push the
	 * workflow input past Temporal's payload limit.
	 */
	content?: string;
	type: string;
	metadata?: {
		filename?: string;
		sourceUrl?: string;
		sourceTitle?: string;
		[key: string]: unknown;
	};
}

export interface ContextEmbeddingWorkflowOutput {
	success: boolean;
	qdrantId?: string;
	error?: string;
}

/**
 * Workflow: Embed a project context for RAG retrieval
 *
 * This is a simple wrapper workflow that provides durability and retry logic
 * around the embedding activity. It's designed to be fire-and-forget from API
 * procedures.
 */
export async function contextEmbeddingWorkflow(
	input: ContextEmbeddingWorkflowInput,
): Promise<ContextEmbeddingWorkflowOutput> {
	console.log(
		`[ContextEmbedding] Starting embedding for context ${input.contextId}`,
	);

	try {
		const result = await embedSingleContextActivity({
			contextId: input.contextId,
			projectId: input.projectId,
			userId: input.userId,
			organizationId: input.organizationId,
			content: input.content,
			type: input.type,
			metadata: input.metadata,
		});

		if (result.success) {
			console.log(
				`[ContextEmbedding] Successfully embedded context ${input.contextId}`,
			);
		} else {
			console.log(
				`[ContextEmbedding] Embedding failed for context ${input.contextId}: ${result.error}`,
			);
		}

		return {
			success: result.success,
			qdrantId: result.qdrantId,
			error: result.error,
		};
	} catch (error: unknown) {
		const errorMessage =
			error instanceof Error ? error.message : "Unknown error";
		console.error(
			`[ContextEmbedding] Workflow failed for context ${input.contextId}: ${errorMessage}`,
		);

		throw ApplicationFailure.nonRetryable(
			errorMessage,
			"CONTEXT_EMBEDDING_FAILED",
		);
	}
}
