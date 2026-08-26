/**
 * RagContextRetrievalWorkflow
 *
 * Durable workflow for retrieving RAG context when documents are attached to a message.
 * This workflow ensures documents are fully processed before attempting retrieval,
 * eliminating the race condition where queries execute before documents finish processing.
 *
 * Flow:
 * 1. Wait for all documents in the chat to reach READY status
 * 2. Retrieve relevant context from vector database (embedding + search)
 * 3. Format context for LLM injection
 * 4. Return formatted context string
 *
 * Features:
 * - Automatic retry on transient failures
 * - Exponential backoff
 * - Timeout handling (returns empty context if documents don't become ready)
 * - Complete execution history for debugging
 * - Multi-tenancy support
 */

import { log, proxyActivities } from "@temporalio/workflow";
import type * as activities from "../activities";
import type {
	RagContextRetrievalInput,
	RagContextRetrievalOutput,
} from "../types";

// Configure activity retry policies
const { waitForDocumentsReadyActivity } = proxyActivities<typeof activities>({
	startToCloseTimeout: "90s", // 90 seconds for waiting (longer than default 60s wait)
	heartbeatTimeout: "30 seconds",
	retry: {
		initialInterval: "2s",
		maximumInterval: "30s",
		backoffCoefficient: 2,
		maximumAttempts: 3, // Limited retries since we have a timeout
	},
});

const { retrieveRagContextActivity } = proxyActivities<typeof activities>({
	startToCloseTimeout: "30s", // 30 seconds for retrieval (embedding + vector search)
	heartbeatTimeout: "30 seconds",
	retry: {
		initialInterval: "2s",
		maximumInterval: "60s",
		backoffCoefficient: 2,
		maximumAttempts: 5,
	},
});

/**
 * RagContextRetrievalWorkflow
 *
 * Retrieves RAG context for a chat message, waiting for documents to be ready first.
 * This workflow is invoked only when documents are attached to a message.
 *
 * @param input - Workflow input containing chatId, userId, query, and retrieval options
 * @returns Workflow output with formatted context string and metadata
 */
export async function ragContextRetrievalWorkflow(
	input: RagContextRetrievalInput,
): Promise<RagContextRetrievalOutput> {
	const {
		chatId,
		userId,
		organizationId,
		query,
		topK = 5,
		minSimilarity = 0.5, // Increased from 0.1 to 0.5 for better relevance
		documentIds,
	} = input;

	console.log(
		"[Workflow] ========== RAG CONTEXT RETRIEVAL WORKFLOW STARTED ==========",
	);
	console.log("[Workflow] Input received:", JSON.stringify(input, null, 2));
	console.log("[Workflow] chatId:", chatId);
	console.log("[Workflow] userId:", userId);
	console.log("[Workflow] organizationId:", organizationId);
	if (documentIds && documentIds.length > 0) {
		console.log("[Workflow] Filtering by specific documents:", documentIds);
	}
	console.log("[Workflow] query:", query.substring(0, 100));

	log.info("Starting RAG context retrieval workflow", {
		chatId,
		userId,
		organizationId,
		queryLength: query.length,
	});

	try {
		// Step 1: Wait for all documents to be ready
		log.info("Waiting for documents to be ready");
		console.log(
			"[Workflow] Waiting for documents to be ready (max 60 seconds)",
		);

		const documentsReady = await waitForDocumentsReadyActivity(
			chatId,
			60000,
		);

		if (!documentsReady) {
			log.warn(
				"Documents not ready after timeout, returning empty context",
			);
			console.log("[Workflow] Documents not ready after timeout");

			return {
				success: true,
				context: "",
				chunkCount: 0,
				documentsReady: false,
			};
		}

		log.info("Documents are ready, proceeding with RAG retrieval");
		console.log("[Workflow] Documents are ready, retrieving context");

		// Step 2: Retrieve RAG context
		log.info("Retrieving RAG context from vector database");
		if (documentIds && documentIds.length > 0) {
			log.info("Filtering by specific documents", { documentIds });
		}
		// Activity fetches its own API key from database using userId/organizationId
		const { context, chunkCount } = await retrieveRagContextActivity(
			chatId,
			userId,
			organizationId,
			query,
			topK,
			minSimilarity,
			documentIds,
		);

		log.info("RAG context retrieved successfully", {
			chunkCount,
			contextLength: context.length,
		});
		console.log("[Workflow] RAG context retrieved successfully");
		console.log("[Workflow] Chunk count:", chunkCount);
		console.log("[Workflow] Context length:", context.length);

		return {
			success: true,
			context,
			chunkCount,
			documentsReady: true,
		};
	} catch (error) {
		// Workflow failed after all retries
		const errorMessage =
			error instanceof Error ? error.message : "Unknown error";

		log.error("RAG context retrieval workflow failed", {
			error: errorMessage,
		});
		console.error("[Workflow] RAG context retrieval failed:", errorMessage);

		// Return empty context instead of failing the entire chat message
		// This allows the chat to continue without RAG context
		return {
			success: false,
			context: "",
			chunkCount: 0,
			documentsReady: false,
			error: errorMessage,
		};
	}
}
