/**
 * Wizard Context Retrieval with Semantic Search
 *
 * This module handles retrieving relevant wizard contexts for:
 * - "Refine with AI" feature during the wizard flow
 * - Providing context to AI for description refinement
 *
 * Security Model:
 * - Access is verified via sessionId + userId + organizationId filtering
 * - Only the session owner can retrieve their wizard contexts
 * - Organization data is in separate Qdrant collections
 */

import { getWizardTempContextById } from "@repo/database";
import { logger } from "@repo/logs";
import { generateEmbedding } from "../embedding";
import { searchWizardContexts } from "./store";
import type {
	RetrievedWizardContext,
	WizardContextRetrievalOptions,
	WizardRetrievalProviderConfig,
} from "./types";

/**
 * Retrieve relevant wizard contexts using semantic search
 *
 * This is the main entry point for RAG retrieval during the wizard flow.
 * Used by the "Refine with AI" feature to find relevant uploaded documents.
 *
 * @param options - Retrieval options
 * @returns Array of relevant contexts with their content
 */
export async function retrieveWizardContexts(
	options: WizardContextRetrievalOptions,
): Promise<RetrievedWizardContext[]> {
	const {
		sessionId,
		query,
		userId,
		organizationId,
		apiKey,
		topK = 5,
		similarityThreshold = 0.5,
	} = options;

	logger.info(
		`[WizardRetrieval] Starting context retrieval for session ${sessionId}`,
	);

	try {
		// Normalize provider config
		const providerConfig: WizardRetrievalProviderConfig =
			typeof apiKey === "string" ? { apiKey } : apiKey;

		// Check API key
		if (!providerConfig.apiKey) {
			throw new Error(
				"No AI provider configured. Please configure an AI provider in Settings.",
			);
		}

		logger.info(
			`[WizardRetrieval] Using settings: topK=${topK}, threshold=${similarityThreshold}`,
		);

		// Generate embedding for the query
		const embeddingResult = await generateEmbedding(
			query,
			{
				userId,
				organizationId: organizationId ?? undefined,
				tags: ["rag-query", "wizard-context"],
			},
			providerConfig,
		);

		if (
			!embeddingResult ||
			!embeddingResult.embedding ||
			embeddingResult.embedding.length === 0
		) {
			logger.warn("[WizardRetrieval] Failed to generate query embedding");
			return [];
		}

		// Search for similar contexts in Qdrant
		const searchResults = await searchWizardContexts({
			sessionId,
			userId,
			organizationId,
			queryEmbedding: embeddingResult.embedding,
			topK,
			minSimilarity: similarityThreshold,
		});

		if (searchResults.length === 0) {
			logger.info("[WizardRetrieval] No similar contexts found");
			return [];
		}

		logger.info(
			`[WizardRetrieval] Found ${searchResults.length} similar contexts`,
		);

		// Deduplicate by contextId (multiple chunks may match)
		const seenContextIds = new Set<string>();
		const uniqueResults = searchResults.filter((result) => {
			if (seenContextIds.has(result.contextId)) {
				return false;
			}
			seenContextIds.add(result.contextId);
			return true;
		});

		// Fetch full context content from database
		const contexts: RetrievedWizardContext[] = [];

		for (const result of uniqueResults) {
			const context = await getWizardTempContextById(
				result.contextId,
				userId,
				organizationId ?? undefined,
			);

			if (context) {
				contexts.push({
					id: context.id,
					type: context.type,
					content: context.content,
					score: result.score,
					filename: context.originalFilename || undefined,
					mimeType: context.mimeType || undefined,
				});
			}
		}

		logger.info(
			`[WizardRetrieval] Returning ${contexts.length} contexts for session ${sessionId}`,
		);

		return contexts;
	} catch (error) {
		logger.error(`[WizardRetrieval] Failed to retrieve contexts: ${error}`);
		throw new Error(
			`Failed to retrieve wizard contexts: ${error instanceof Error ? error.message : "Unknown error"}`,
		);
	}
}

/**
 * Format retrieved wizard contexts for injection into LLM prompts
 *
 * @param contexts - Retrieved wizard contexts
 * @returns Formatted string for prompt injection
 */
export function formatWizardContextsForPrompt(
	contexts: RetrievedWizardContext[],
): string {
	if (contexts.length === 0) {
		return "";
	}

	const formattedContexts = contexts.map((ctx, index) => {
		const source = ctx.filename || `Document ${index + 1}`;
		return `--- ${source} (${ctx.type}, relevance: ${(ctx.score * 100).toFixed(1)}%) ---\n${ctx.content}`;
	});

	return `
<reference_documents>
The following context was retrieved from uploaded reference documents. Use this information to inform your response:

${formattedContexts.join("\n\n")}
</reference_documents>
`.trim();
}
