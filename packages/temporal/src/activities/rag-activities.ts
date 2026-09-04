/**
 * Activities for RAG context retrieval
 * Activities are non-deterministic operations that can fail and be retried
 */

import { getSystemRAGProviderConfig } from "@repo/ai";
import { waitForDocumentsReady } from "@repo/database";
import { logger } from "@repo/logs";
import { formatContextForLLM, retrieveContext } from "@repo/rag";

/**
 * Wait for all documents in a chat to be ready
 * Wraps the database helper function for use in Temporal workflows
 *
 * @param chatId - Chat ID to check
 * @param maxWaitMs - Maximum time to wait in milliseconds (default: 60000 = 1 minute)
 * @returns true if all documents are ready, false if timeout or any failed
 * @throws Error if database query fails
 */
export async function waitForDocumentsReadyActivity(
	chatId: string,
	maxWaitMs = 60000,
): Promise<boolean> {
	console.log(
		`[Activity] Waiting for documents to be ready in chat: ${chatId}`,
	);
	console.log(`[Activity] Max wait time: ${maxWaitMs}ms`);

	try {
		const result = await waitForDocumentsReady(chatId, maxWaitMs, 1000);

		console.log(
			`[Activity] Wait result: ${result ? "All documents ready" : "Timeout or failed documents"}`,
		);

		return result;
	} catch (error) {
		console.error("[Activity] Failed to wait for documents:", error);
		throw new Error(
			`Failed to wait for documents: ${error instanceof Error ? error.message : "Unknown error"}`,
		);
	}
}

/**
 * Retrieve RAG context from vector database
 * Combines embedding generation, vector search, and context formatting
 *
 * SECURITY: This activity fetches its own API key from the database using
 * the centralized getSystemRAGProviderConfig() function. API keys should never
 * be passed as workflow arguments as they would be stored in Temporal history.
 *
 * @param chatId - Chat ID to search within
 * @param userId - User ID (for multi-tenancy and API key resolution)
 * @param organizationId - Organization ID (for multi-tenancy and API key resolution)
 * @param query - User's query text
 * @param topK - Number of results to return (default: 5)
 * @param minSimilarity - Minimum similarity threshold (default: 0.1)
 * @param documentIds - Optional: Specific document IDs to retrieve context from
 * @returns Formatted context string ready to inject as system message
 */
export async function retrieveRagContextActivity(
	chatId: string,
	userId: string,
	organizationId: string | undefined,
	query: string,
	topK = 5,
	minSimilarity = 0.1,
	documentIds?: string[],
): Promise<{ context: string; chunkCount: number }> {
	console.log(`[Activity] Retrieving RAG context for chat: ${chatId}`);
	console.log(`[Activity] Query: "${query.substring(0, 100)}..."`);
	console.log(`[Activity] User ID: ${userId}`);
	console.log(`[Activity] Organization ID: ${organizationId}`);
	console.log(`[Activity] Top K: ${topK}, Min Similarity: ${minSimilarity}`);

	try {
		// Fetch API key from database using centralized function
		// This ensures keys are never passed through Temporal workflow history
		let apiKey: string | undefined;
		try {
			const providerConfig = await getSystemRAGProviderConfig({
				userId,
				organizationId,
			});
			apiKey = providerConfig.apiKey;
			logger.info("[Activity] Retrieved API key from database");
		} catch (_error) {
			logger.warn(
				"[Activity] No AI provider configured, proceeding without API key",
			);
			// Continue without API key - retrieveContext will handle this
		}

		// Retrieve relevant chunks from vector database
		logger.info("[Activity] Calling retrieveContext");
		if (documentIds && documentIds.length > 0) {
			logger.info(
				`[Activity] Filtering by specific documents: ${documentIds.join(", ")}`,
			);
		}
		const relevantChunks = await retrieveContext({
			chatId,
			userId,
			organizationId,
			query,
			topK,
			minSimilarity,
			apiKey,
			documentIds,
			// This activity only runs for documents the user explicitly attached
			// to a message, so drop the similarity floor — the attached content
			// must reach the model even when the question isn't a close match.
			explicitAttachment: true,
		});

		console.log(
			`[Activity] Found ${relevantChunks.length} relevant chunks`,
		);

		// Format context for LLM with enhanced instructions
		// If specific documentIds were provided, this is a follow-up message with new documents
		const isNewDocument = documentIds && documentIds.length > 0;
		const context = formatContextForLLM(relevantChunks, {
			isNewDocument,
			documentIds,
		});

		console.log(
			`[Activity] Formatted context length: ${context.length} characters`,
		);
		if (isNewDocument) {
			console.log(
				"[Activity] New document context - emphasizing newly attached documents",
			);
		}

		return {
			context,
			chunkCount: relevantChunks.length,
		};
	} catch (error) {
		console.error("[Activity] Failed to retrieve RAG context:", error);
		logger.error(`[Activity] RAG retrieval error: ${error}`);

		// Don't throw - return empty context to allow chat to continue without RAG
		// This matches the behavior of retrieveContext which returns [] on error
		return {
			context: "",
			chunkCount: 0,
		};
	}
}
