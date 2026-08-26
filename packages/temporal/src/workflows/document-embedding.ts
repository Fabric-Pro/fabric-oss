/**
 * Document Embedding Workflow
 *
 * A durable workflow for embedding project documents (PRD, Proposal) into Qdrant
 * for RAG retrieval. This workflow is triggered:
 * - After document generation completes
 * - When a user edits a document
 * - When a document is regenerated
 *
 * Benefits of using Temporal:
 * - Automatic retries on transient failures (API errors, rate limits)
 * - Durability (survives server restarts)
 * - Visibility and monitoring
 * - Consistent error handling
 */

import { ApplicationFailure, proxyActivities } from "@temporalio/workflow";
import type * as activities from "../activities";

const { embedProjectDocumentActivity } = proxyActivities<typeof activities>({
	// Large documents can produce 100+ chunks. With 25-per-batch embedding and
	// parallel Qdrant upserts the attempt should complete in ~30–90 s, but we
	// keep a generous ceiling so genuinely huge docs don't flap between retries.
	// The 10 s heartbeat interval still catches a dead worker within seconds.
	startToCloseTimeout: "15 minutes",
	heartbeatTimeout: "30 seconds",
	retry: {
		initialInterval: "1s",
		maximumInterval: "30s",
		backoffCoefficient: 2,
		maximumAttempts: 3,
	},
});

export interface DocumentEmbeddingWorkflowInput {
	documentId: string;
	userId: string;
	organizationId?: string;
}

export interface DocumentEmbeddingWorkflowOutput {
	success: boolean;
	error?: string;
}

/**
 * Workflow: Embed a project document for RAG retrieval
 *
 * This is a simple wrapper workflow that provides durability and retry logic
 * around the embedding activity. It's designed to be fire-and-forget from API
 * procedures.
 */
export async function documentEmbeddingWorkflow(
	input: DocumentEmbeddingWorkflowInput,
): Promise<DocumentEmbeddingWorkflowOutput> {
	console.log(
		`[DocumentEmbedding] Starting embedding for document ${input.documentId}`,
	);

	try {
		const result = await embedProjectDocumentActivity({
			documentId: input.documentId,
			userId: input.userId,
			organizationId: input.organizationId,
		});

		if (result.success) {
			console.log(
				`[DocumentEmbedding] Successfully embedded document ${input.documentId}`,
			);
		} else {
			console.log(
				`[DocumentEmbedding] Embedding failed for document ${input.documentId}: ${result.error}`,
			);
		}

		return {
			success: result.success,
			error: result.error,
		};
	} catch (error: unknown) {
		const errorMessage =
			error instanceof Error ? error.message : "Unknown error";
		console.error(
			`[DocumentEmbedding] Workflow failed for document ${input.documentId}: ${errorMessage}`,
		);

		throw ApplicationFailure.nonRetryable(
			errorMessage,
			"DOCUMENT_EMBEDDING_FAILED",
		);
	}
}
