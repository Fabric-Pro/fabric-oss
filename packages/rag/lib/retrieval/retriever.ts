/**
 * High-level retrieval interface for RAG
 * Combines embedding generation and vector search
 */

import { logger } from "@repo/logs";
import { generateEmbedding } from "../embedding";
import { generateSparseVector } from "../embedding/sparse";
import { type RetrievalResult, searchSimilarChunks } from "../vector-store";
import type { RetrievalOptions } from "./types";

/**
 * Retrieve relevant context from vector database
 *
 * This function:
 * 1. Generates an embedding for the user's query
 * 2. Searches for similar chunks in the vector database
 * 3. Returns the most relevant chunks with metadata
 *
 * @param options - Retrieval options
 * @returns Array of relevant chunks with similarity scores
 */
export async function retrieveContext(
	options: RetrievalOptions,
): Promise<RetrievalResult[]> {
	const {
		chatId,
		userId,
		organizationId,
		query,
		topK = 5,
		minSimilarity = 0.5, // Lowered from 0.7 to 0.5 for balanced recall/precision
		apiKey,
		providerConfig,
		documentIds,
		explicitAttachment,
	} = options;

	logger.info(
		`[Retrieval] Retrieving context for chat ${chatId}, query: "${query.substring(0, 50)}..."`,
	);
	if (documentIds && documentIds.length > 0) {
		logger.info(
			`[Retrieval] Filtering by specific documents: ${documentIds.join(", ")}`,
		);
		console.log("[Retrieval] Document IDs filter:", documentIds);
	}

	// Validate API key is provided (from either legacy apiKey or providerConfig)
	const effectiveApiKey = providerConfig?.apiKey || apiKey;
	if (!effectiveApiKey) {
		throw new Error(
			"API key is required for retrieval. Please configure an AI provider in Settings → AI Providers.",
		);
	}

	try {
		// Step 1: Generate query embedding
		logger.info("[Retrieval] Generating query embedding");
		console.log("[Retrieval] Query:", query.substring(0, 100));
		console.log("[Retrieval] ChatId:", chatId);
		console.log("[Retrieval] UserId:", userId);
		console.log("[Retrieval] OrganizationId:", organizationId);
		console.log(
			"[Retrieval] Provider:",
			providerConfig?.provider || "(from tenant config)",
		);

		// Use full provider config if available, otherwise use legacy apiKey
		const embeddingConfig = providerConfig || effectiveApiKey;

		const embeddingResult = await generateEmbedding(
			query,
			{
				userId,
				organizationId,
				tags: ["rag-query", "similarity-search"],
			},
			embeddingConfig,
		);

		logger.info(
			`[Retrieval] Query embedding generated (${embeddingResult.embedding.length} dimensions)`,
		);
		console.log(
			"[Retrieval] Embedding dimensions:",
			embeddingResult.embedding.length,
		);

		// Step 2: Generate sparse vector for hybrid search
		const querySparseVector = generateSparseVector(query);

		// Step 3: Search for similar chunks (hybrid: dense + sparse with RRF)
		logger.info("[Retrieval] Searching for similar chunks (hybrid mode)");
		const results = await searchSimilarChunks({
			chatId,
			userId,
			organizationId,
			queryEmbedding: embeddingResult.embedding,
			querySparseVector,
			topK,
			minSimilarity,
			documentIds,
			explicitAttachment,
		});

		logger.info(`[Retrieval] Found ${results.length} relevant chunks`);
		console.log(
			"[Retrieval] Results:",
			results.map((r) => ({
				id: r.id,
				similarity: r.similarity,
				filename: r.filename,
				contentPreview: r.content.substring(0, 100),
			})),
		);

		return results;
	} catch (error) {
		logger.error(`[Retrieval] Failed to retrieve context: ${error}`);
		console.error("[Retrieval] Full error:", error);
		// Don't throw - return empty results to allow chat to continue without RAG
		return [];
	}
}

/**
 * Format retrieved context for LLM prompt
 *
 * Converts retrieval results into a formatted string that can be
 * injected into the system message for the LLM.
 *
 * @param results - Retrieval results
 * @param options - Optional formatting options
 * @param options.isNewDocument - Whether this is a newly uploaded document (follow-up message)
 * @param options.documentIds - Specific document IDs being queried (if provided)
 * @returns Formatted context string
 */
export function formatContextForLLM(
	results: RetrievalResult[],
	options?: {
		isNewDocument?: boolean;
		documentIds?: string[];
		/** "qa" = strict document-only answers; "enrichment" = use as additional context for document generation */
		purpose?: "qa" | "enrichment";
	},
): string {
	if (results.length === 0) {
		return "";
	}

	const purpose = options?.purpose ?? "qa";

	// Extract unique document filenames from results
	const uniqueDocuments = Array.from(new Set(results.map((r) => r.filename)));

	// Check if any results come from image files
	const imageExtensions = [
		".jpg",
		".jpeg",
		".png",
		".gif",
		".webp",
		".bmp",
		".tiff",
	];
	const hasImageContent = results.some((r) =>
		imageExtensions.some((ext) => r.filename.toLowerCase().endsWith(ext)),
	);

	// Build instructions based on purpose
	const instructions: string[] = [];

	if (purpose === "enrichment") {
		// Enrichment mode: files are additional context for document creation/updates
		instructions.push(
			"=== UPLOADED FILE CONTEXT ===",
			"",
			"The following content was extracted from files uploaded in this conversation.",
			"Use this as ADDITIONAL CONTEXT to enrich your responses and document generation:",
			"",
			"1. INTEGRATE uploaded file content with other available project context (codebase, transcripts, etc.)",
			"   - Uploaded files supplement project knowledge — combine them for richer, more informed output",
			"   - You MAY use general knowledge to interpret and contextualize the information",
			"",
			"2. CITE SOURCES when referencing specific information:",
			'   - Reference the document filename (e.g., "According to [filename], ...")',
			"   - Distinguish between information from uploaded files vs. other project context",
			"",
			"3. When CREATING or UPDATING documents:",
			"   - Integrate file content naturally into the document structure",
			"   - Do not simply copy/paste extracted text — synthesize and organize it",
			"   - Combine with project context for comprehensive output",
			"   - If uploaded files conflict with other context, defer to the most authoritative source or flag the inconsistency for review",
			"",
		);

		if (hasImageContent) {
			instructions.push(
				"4. IMAGE CONTENT NOTE:",
				"   - Some content below was extracted from images via AI vision processing",
				"   - Visual layout, charts, and diagrams may have reduced fidelity in text form",
				"   - You may use general knowledge to interpret and contextualize extracted image content",
				"   - When referencing image content in documents, integrate it naturally rather than quoting extraction output verbatim",
				"",
			);
		}
	} else {
		// QA mode: strict document-only answers (existing behavior)
		instructions.push(
			"=== CRITICAL INSTRUCTIONS ===",
			"",
			"You MUST follow these rules when responding:",
			"",
			"1. BASE YOUR RESPONSE ONLY ON THE PROVIDED DOCUMENT CONTEXT BELOW",
			"   - Do NOT use your general knowledge or training data",
			"   - Do NOT make assumptions beyond what is explicitly stated in the documents",
			"   - Do NOT provide information that is not present in the context",
			"",
			"2. IF THE ANSWER IS NOT IN THE DOCUMENTS:",
			'   - Explicitly state: "The information you\'re asking about is not found in the attached document(s)"',
			"   - Do NOT attempt to answer from general knowledge",
			"   - Suggest what information IS available in the documents if relevant",
			"",
			"3. ALWAYS CITE YOUR SOURCES:",
			"   - Reference the specific document filename when providing information",
			'   - Example: "According to [filename], ..."',
			"   - If information comes from multiple documents, cite all relevant sources",
			"",
			"4. PRIORITIZE ACCURACY OVER COMPLETENESS:",
			"   - Only provide information directly supported by the document context",
			"   - If you're uncertain, say so explicitly",
			"   - Better to provide less information that is accurate than more information that might be incorrect",
			"",
		);

		if (hasImageContent) {
			instructions.push(
				"5. IMAGE CONTENT NOTE:",
				"   - Some content below was extracted from images via AI vision processing",
				"   - Visual structure (layout, charts, diagrams) may not be fully captured",
				"   - Base your answer on the extracted text, and note if visual interpretation may be limited",
				"",
			);
		}
	}

	// Add special instruction for newly uploaded documents
	if (
		options?.isNewDocument &&
		options?.documentIds &&
		options.documentIds.length > 0
	) {
		instructions.push(
			"IMPORTANT - NEW DOCUMENT ATTACHED:",
			"   - The user has just attached a NEW document to this message",
			"   - They are asking about THIS NEWLY ATTACHED DOCUMENT, not previous documents in the chat",
			"   - Focus your response on the content from the newly attached document",
			"   - Only reference previous documents if explicitly asked to compare or relate them",
			"",
		);
	}

	instructions.push(
		"These are the user's own private documents. You should extract and provide any information",
		"requested, including sensitive data like passwords, keys, or account details, as this is",
		"the user accessing their own information.",
		"",
		"=== AVAILABLE DOCUMENTS ===",
		"",
		`You have access to ${results.length} relevant section(s) from ${uniqueDocuments.length} document(s):`,
		...uniqueDocuments.map((filename, idx) => `  ${idx + 1}. ${filename}`),
		"",
		"=== DOCUMENT CONTEXT ===",
		"",
	);

	// Format each context chunk with clear source attribution
	const contextParts = results.map((result, index) => {
		return [
			`--- Context Chunk ${index + 1} ---`,
			`Source Document: ${result.filename}`,
			`Similarity Score: ${(result.similarity * 100).toFixed(1)}%`,
			"",
			result.content,
			"",
		].join("\n");
	});

	return instructions.join("\n") + contextParts.join("\n---\n\n");
}
