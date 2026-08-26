/**
 * Contextual Chunk Enrichment
 *
 * Uses a fast LLM to generate a one-line context summary for each chunk,
 * situating it within the overall document. This summary is prepended to
 * the chunk content before embedding, dramatically improving retrieval quality.
 *
 * Based on Anthropic's "Contextual Retrieval" research which shows ~49%
 * reduction in retrieval failures when chunks include document-level context.
 *
 * Design:
 * - Optional per workspace/project (adds indexing cost and latency)
 * - Uses a cheap/fast model (Haiku or GPT-4o-mini) to minimize cost
 * - Batches chunks per document to minimize LLM calls
 * - Stores original content and context separately
 *
 * @see https://www.anthropic.com/news/contextual-retrieval
 */

import { getAIModelWithMetadata, logModelUsageAsync } from "@repo/ai";
import { logger } from "@repo/logs";
import { generateText } from "ai";
import type { TextChunk } from "./types";

/**
 * Options for contextual enrichment
 */
export interface ContextualEnrichmentOptions {
	/** Full document content (used as context for the LLM) */
	documentContent: string;

	/** Document filename / title */
	documentTitle: string;

	/**
	 * Function to call the LLM for context generation.
	 * Injected to avoid coupling chunking package to specific LLM providers.
	 *
	 * @param systemPrompt - System prompt for the LLM
	 * @param userPrompt - User prompt with the chunk
	 * @returns Generated context string
	 */
	generateContext: (
		systemPrompt: string,
		userPrompt: string,
	) => Promise<string>;

	/** Max characters of document to include in context window (default: 8000) */
	maxDocumentContextChars?: number;
}

/**
 * Enriched chunk with original content preserved separately
 */
export interface EnrichedChunk extends TextChunk {
	/** The LLM-generated context summary */
	contextSummary: string;

	/** Content with context prepended (used for embedding) */
	enrichedContent: string;

	/** Original content without context (stored in DB) */
	originalContent: string;
}

export interface TenantBackedContextualEnrichmentOptions {
	documentContent: string;
	documentTitle: string;
	userId: string;
	organizationId?: string;
	projectId?: string;
	maxDocumentContextChars?: number;
}

const CONTEXT_SYSTEM_PROMPT = `You are a document context specialist. Your task is to provide a brief context sentence for a text chunk, situating it within the larger document.

Rules:
- Write exactly ONE sentence (max 100 words)
- Include the document title/type and what section this chunk is from
- Focus on WHAT this chunk is about and WHERE it fits in the document
- Do NOT summarize the chunk content — just provide context
- Do NOT start with "This chunk" or "This section"
- Be specific and factual`;

/**
 * Enrich chunks with document-level context.
 *
 * For each chunk, generates a one-line context summary using an LLM,
 * then prepends it to the chunk content for embedding.
 *
 * @param chunks - Text chunks to enrich
 * @param options - Enrichment options including LLM function
 * @returns Enriched chunks with context summaries
 */
export async function enrichChunksWithContext(
	chunks: TextChunk[],
	options: ContextualEnrichmentOptions,
): Promise<EnrichedChunk[]> {
	const {
		documentContent,
		documentTitle,
		generateContext,
		maxDocumentContextChars = 8000,
	} = options;

	if (chunks.length === 0) {
		return [];
	}

	const startTime = Date.now();
	logger.info(
		`[ContextualEnrichment] Enriching ${chunks.length} chunks for "${documentTitle}"`,
	);

	// Truncate document content for context window
	const truncatedDoc =
		documentContent.length > maxDocumentContextChars
			? `${documentContent.slice(0, maxDocumentContextChars)}...\n[Document truncated — ${documentContent.length} total chars]`
			: documentContent;

	const enrichedChunks: EnrichedChunk[] = [];

	// Process chunks sequentially to avoid overwhelming the LLM
	// (could be parallelized with rate limiting for faster throughput)
	for (const chunk of chunks) {
		try {
			const userPrompt = `Document: "${documentTitle}"

<full_document>
${truncatedDoc}
</full_document>

<chunk>
${chunk.content}
</chunk>

Provide a brief context sentence for this chunk:`;

			const contextSummary = await generateContext(
				CONTEXT_SYSTEM_PROMPT,
				userPrompt,
			);

			const trimmedContext = contextSummary.trim();
			const enrichedContent = `[Context: ${trimmedContext}]\n\n${chunk.content}`;

			enrichedChunks.push({
				...chunk,
				contextSummary: trimmedContext,
				enrichedContent,
				originalContent: chunk.content,
			});
		} catch (error) {
			logger.warn(
				`[ContextualEnrichment] Failed to enrich chunk ${chunk.index}, using original: ${error}`,
			);
			// Fall back to original content if enrichment fails
			enrichedChunks.push({
				...chunk,
				contextSummary: "",
				enrichedContent: chunk.content,
				originalContent: chunk.content,
			});
		}
	}

	const durationMs = Date.now() - startTime;
	const enrichedCount = enrichedChunks.filter(
		(c) => c.contextSummary.length > 0,
	).length;
	logger.info(
		`[ContextualEnrichment] Enriched ${enrichedCount}/${chunks.length} chunks in ${durationMs}ms`,
	);

	return enrichedChunks;
}

export async function enrichChunksWithTenantContext(
	chunks: TextChunk[],
	options: TenantBackedContextualEnrichmentOptions,
): Promise<EnrichedChunk[]> {
	const {
		documentContent,
		documentTitle,
		userId,
		organizationId,
		projectId,
	} = options;

	return enrichChunksWithContext(chunks, {
		documentContent,
		documentTitle,
		maxDocumentContextChars: options.maxDocumentContextChars,
		generateContext: async (systemPrompt, userPrompt) => {
			const { model, metadata, trackUsage } =
				await getAIModelWithMetadata(
					{
						taskType: "SIMPLE",
						complexity: "simple",
					},
					{ userId, organizationId },
				);

			const generationStart = Date.now();
			const result = await generateText({
				model,
				system: systemPrompt,
				prompt: userPrompt,
			});

			trackUsage();
			logModelUsageAsync({
				context: { userId, organizationId },
				metadata,
				taskType: "SIMPLE",
				usage: result.usage,
				latencyMs: Date.now() - generationStart,
				projectId,
			});

			return result.text;
		},
	});
}
