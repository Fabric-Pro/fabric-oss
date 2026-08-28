/**
 * Automatic Embedding Service for Project Contexts
 *
 * This module provides automatic embedding generation and updates for project contexts.
 * It ensures that embeddings are created/updated whenever context content changes.
 *
 * Key Features:
 * - Automatic embedding on context creation
 * - Re-embedding on content updates
 * - Cleanup of stale embeddings on deletion
 * - Batch processing for efficiency
 * - Uses project's RAG settings for chunking configuration
 * - Smart chunking based on content size and type
 *
 * Chunking Strategy (based on research):
 * - Small content (<2048 chars): Single embedding
 * - Large content: Chunk using project's configured strategy
 * - Default: 512 tokens with 50 token overlap
 *
 * @see https://weaviate.io/blog/chunking-strategies-for-rag
 */

import { getProjectRagSettings, markContextAsEmbedded } from "@repo/database";
import { logger } from "@repo/logs";
import {
	type ChunkingStrategy,
	type ContentRoute,
	chunkDescribedOpenApiSpec,
	chunkText,
	detectContentType,
	enrichChunksWithTenantContext,
	routeContentForChunking,
	type TextChunk,
} from "../chunking";
import { generateEmbedding } from "../embedding";
import { deleteProjectContext, storeProjectContext } from "./store";

/**
 * Provider configuration for embeddings
 */
export interface EmbedProviderConfig {
	apiKey: string;
	provider?: string | null;
	baseUrl?: string | null;
}

export interface EmbedContextOptions {
	contextId: string;
	projectId: string;
	userId: string;
	organizationId?: string;
	content: string;
	type: string;
	/** API key string (legacy) or full provider config */
	apiKey: string | EmbedProviderConfig;
	metadata?: {
		filename?: string;
		/** Declared so spec detection can skip non-JSON/YAML content cheaply. */
		mimeType?: string;
		sourceUrl?: string;
		sourceTitle?: string;
		[key: string]: unknown;
	};
	/**
	 * Skip the post-embed `markContextAsEmbedded` DB update. Default false
	 * (legacy behaviour). Set to true when the caller owns its own row in a
	 * sibling table — e.g. URL Context Sources child pages live in
	 * `ProjectContextUrlPage` and the calling activity does its own
	 * `projectContextUrlPage.update(...)` afterwards. Without this opt-out,
	 * embedProjectContext tries `projectContext.update({ id: pageId })` and
	 * throws because the row is in the wrong table.
	 */
	skipDbUpdate?: boolean;
}

/**
 * Normalize apiKey to full provider config
 */
function normalizeProviderConfig(
	apiKey: string | EmbedProviderConfig,
): EmbedProviderConfig {
	if (typeof apiKey === "string") {
		return { apiKey };
	}
	return apiKey;
}

export interface EmbedResult {
	success: boolean;
	qdrantId?: string;
	error?: string;
	chunksCreated?: number;
}

/**
 * Threshold for chunking - content smaller than this is embedded as single chunk
 * 2048 chars ≈ 512 tokens - the recommended baseline chunk size
 */
const CHUNKING_THRESHOLD = 2048;

/**
 * Map database ChunkSplitMethod to chunking strategy
 */
function mapSplitMethodToStrategy(splitMethod: string): ChunkingStrategy {
	switch (splitMethod) {
		case "SENTENCE":
			return "SENTENCE";
		case "FIXED":
			return "FIXED";
		case "RECURSIVE":
			return "RECURSIVE";
		case "DOCUMENT":
			return "DOCUMENT";
		case "SEMANTIC":
			return "SEMANTIC";
		default:
			return "PARAGRAPH";
	}
}

/**
 * Embed a single project context
 *
 * This function:
 * 1. Determines if content needs chunking based on size
 * 2. Chunks the content based on project RAG settings (if needed)
 * 3. Generates embeddings for each chunk
 * 4. Stores embeddings in Qdrant with proper isolation
 * 5. Updates the database with embedding status
 *
 * Chunking Strategy:
 * - Small content (<2048 chars): Single embedding for efficiency
 * - Large content: Chunk using project's configured strategy
 * - Auto-detect content type for optimal chunking
 *
 * @param options - Embed options
 * @returns Embed result
 */
export async function embedProjectContext(
	options: EmbedContextOptions,
): Promise<EmbedResult> {
	const {
		contextId,
		projectId,
		userId,
		organizationId,
		content,
		type,
		apiKey,
		metadata,
		skipDbUpdate = false,
	} = options;

	logger.info(
		`[AutoEmbed] Embedding context ${contextId} for project ${projectId}`,
	);

	try {
		// Skip if no content
		if (!content || content.trim().length === 0) {
			logger.warn(
				`[AutoEmbed] Context ${contextId} has no content, skipping`,
			);
			return { success: true, chunksCreated: 0 };
		}

		// Normalize provider config
		const providerConfig = normalizeProviderConfig(apiKey);

		// Check API key
		if (!providerConfig.apiKey) {
			throw new Error(
				"No AI provider configured. Please configure an AI provider in Settings → AI Providers.",
			);
		}

		// Get project's RAG settings for chunking configuration
		const ragSettings = await getProjectRagSettings(projectId);

		// Determine if we need to chunk.
		//
		// A spec goes down the chunking path regardless of size. The size test
		// alone sent a spec under 2048 chars to the single-blob path below, where
		// routing is never consulted — so the same small spec came out
		// endpoint-chunked through `chunkProjectContent` and as one undifferentiated
		// vector through here, with no error either way. That is the exact
		// same-file-two-results bug the shared router exists to remove.
		const specRoute = await routeContentForChunking({
			content,
			mimeType: metadata?.mimeType || "",
			filename: metadata?.filename || contextId,
		});
		const needsChunking =
			specRoute.kind !== "text" || content.length > CHUNKING_THRESHOLD;

		if (needsChunking) {
			// Route computed once and handed down — it carries the parsed
			// document, so nothing below re-parses the spec.
			return await embedWithChunking(options, ragSettings, specRoute);
		}

		// Small content - embed as single chunk
		const embeddingResult = await generateEmbedding(
			content,
			{
				userId,
				organizationId,
				projectId,
				tags: ["project-context", type.toLowerCase()],
			},
			providerConfig,
		);

		if (
			!embeddingResult ||
			!embeddingResult.embedding ||
			embeddingResult.embedding.length === 0
		) {
			throw new Error("Failed to generate embedding");
		}

		// Store in Qdrant
		// IMPORTANT: Always set originalContextId so filter-based deletion works consistently
		const qdrantId = await storeProjectContext({
			contextId,
			projectId,
			userId,
			organizationId,
			content,
			embedding: embeddingResult.embedding,
			metadata: {
				type,
				filename: metadata?.filename,
				sourceUrl: metadata?.sourceUrl,
				sourceTitle: metadata?.sourceTitle,
				provider: metadata?.provider,
				chunkIndex: 0,
				totalChunks: 1,
				// originalContextId enables filter-based deletion
				originalContextId: contextId,
				// Captured conversation bundles (Fizzy #2228) are embedded under
				// their OWN row id, in a table the retrieval refetch does not
				// otherwise look in. Forwarding these two is what lets a hit say
				// "this is a bundle, here is its id" — without them the caller's
				// metadata stops here and the point is unresolvable.
				conversationBundleId: metadata?.conversationBundleId,
				parentContextId: metadata?.parentContextId,
			},
		});

		// Update database with embedding status.
		// Skipped when the caller owns its own row in a sibling table (see
		// EmbedContextOptions.skipDbUpdate). URL Context Sources child pages
		// live in ProjectContextUrlPage, not ProjectContext, so embedding
		// them with skipDbUpdate=true avoids `projectContext.update({ id:
		// pageId })` failing with "No record was found for an update".
		if (!skipDbUpdate) {
			await markContextAsEmbedded(contextId, qdrantId);
		}

		logger.info(
			`[AutoEmbed] Successfully embedded context ${contextId} (single chunk)`,
		);

		return {
			success: true,
			qdrantId,
			chunksCreated: 1,
		};
	} catch (error) {
		const errorMessage =
			error instanceof Error ? error.message : "Unknown error";
		logger.error(
			`[AutoEmbed] Failed to embed context ${contextId}: ${errorMessage}`,
		);

		return {
			success: false,
			error: errorMessage,
		};
	}
}

/**
 * Embed content with chunking
 * Used for large content that needs to be split into multiple chunks
 */
async function embedWithChunking(
	options: EmbedContextOptions,
	ragSettings: {
		chunkSize: number;
		chunkOverlap: number;
		splitMethod: string;
	},
	specRoute: ContentRoute,
): Promise<EmbedResult> {
	const {
		contextId,
		projectId,
		userId,
		organizationId,
		content,
		type,
		apiKey,
		metadata,
		skipDbUpdate = false,
	} = options;

	// Normalize provider config
	const providerConfig = normalizeProviderConfig(apiKey);

	logger.info(
		`[AutoEmbed] Chunking content (${content.length} chars) with strategy=${ragSettings.splitMethod}, size=${ragSettings.chunkSize}`,
	);

	// An OpenAPI spec is chunked by endpoint here too. This is the third of the
	// three chunking implementations that existed before Fizzy #2236 — the one
	// driven by the project's RAG settings rather than by MIME — and a re-embed
	// arriving here without the spec route would quietly replace endpoint chunks
	// with character windows. The route arrives already computed, carrying the
	// parsed document with it.

	// A malformed spec must not be quietly indexed as prose here either. The
	// upload path fails the row for this; failing the embed keeps the two paths
	// telling the same story instead of one accepting what the other rejected.
	if (specRoute.kind === "malformed-openapi") {
		const reason = `This file looks like an OpenAPI/Swagger document but could not be read: ${specRoute.reason}`;
		logger.warn(`[AutoEmbed] ${reason}`);
		return { success: false, error: reason };
	}

	let chunks: TextChunk[];
	let specPayloads: Array<Record<string, unknown>> = [];

	if (specRoute.kind === "openapi") {
		const specChunks = chunkDescribedOpenApiSpec(
			specRoute.description,
			metadata?.filename || contextId,
		);
		chunks = specChunks;
		specPayloads = specChunks.map((chunk) => ({
			specTitle: chunk.specMetadata.specTitle,
			specVersion: chunk.specMetadata.specVersion,
			specChunkKind: chunk.specMetadata.kind,
			httpMethod: chunk.specMetadata.httpMethod ?? null,
			path: chunk.specMetadata.path ?? null,
			operationId: chunk.specMetadata.operationId ?? null,
			operationTags: chunk.specMetadata.operationTags ?? null,
		}));
		logger.info(
			`[AutoEmbed] OpenAPI spec detected — ${specChunks.length} endpoint/model chunks`,
		);
	} else {
		// Detect content type for optimal chunking
		const contentInfo = detectContentType(content);

		// Map database split method to chunking strategy
		// For markdown/code content, prefer DOCUMENT strategy regardless of settings
		let strategy = mapSplitMethodToStrategy(ragSettings.splitMethod);
		if (contentInfo.type === "markdown" || contentInfo.type === "code") {
			strategy = "DOCUMENT";
			logger.info(
				`[AutoEmbed] Using DOCUMENT strategy for ${contentInfo.type} content`,
			);
		}

		// Chunk the content
		chunks = chunkText(content, metadata?.filename || contextId, {
			strategy,
			chunkSize: ragSettings.chunkSize,
			chunkOverlap: ragSettings.chunkOverlap,
			contentType: contentInfo.type,
		});
	}
	const enrichedChunks = await enrichChunksWithTenantContext(chunks, {
		documentContent: content,
		documentTitle: metadata?.filename || contextId,
		userId,
		organizationId,
		projectId,
	});

	logger.info(
		`[AutoEmbed] Created ${enrichedChunks.length} chunks for context ${contextId}`,
	);

	// Generate embeddings and store each chunk
	let firstQdrantId: string | undefined;
	let successCount = 0;
	const errors: string[] = [];

	for (const chunk of enrichedChunks) {
		try {
			const embeddingResult = await generateEmbedding(
				chunk.enrichedContent,
				{
					userId,
					organizationId,
					projectId,
					tags: [
						"project-context",
						type.toLowerCase(),
						`chunk-${chunk.index}`,
					],
				},
				providerConfig,
			);

			if (
				!embeddingResult ||
				!embeddingResult.embedding ||
				embeddingResult.embedding.length === 0
			) {
				logger.warn(
					`[AutoEmbed] Failed to generate embedding for chunk ${chunk.index}`,
				);
				errors.push(`Chunk ${chunk.index}: Empty embedding result`);
				continue;
			}

			// Use contextId-chunkIndex as unique ID for each chunk
			const chunkContextId =
				enrichedChunks.length > 1
					? `${contextId}-chunk-${chunk.index}`
					: contextId;

			// IMPORTANT: Always set originalContextId so filter-based deletion
			// can find and delete ALL chunks for a context (fixes orphaned chunk issue)
			const qdrantId = await storeProjectContext({
				contextId: chunkContextId,
				projectId,
				userId,
				organizationId,
				content: chunk.originalContent,
				embedding: embeddingResult.embedding,
				metadata: {
					type: specRoute.kind === "openapi" ? "API_SPEC" : type,
					filename: metadata?.filename,
					sourceUrl: metadata?.sourceUrl,
					sourceTitle: metadata?.sourceTitle,
					provider: metadata?.provider,
					// Endpoint/model identity on spec chunks; empty otherwise.
					...(specPayloads[chunk.index] ?? {}),
					chunkIndex: chunk.index,
					totalChunks: enrichedChunks.length,
					headings: chunk.metadata.headings,
					section: chunk.metadata.section,
					// originalContextId enables filter-based deletion of all chunks
					originalContextId: contextId,
					// See the single-chunk path: a long captured conversation
					// chunks like anything else, and every one of its chunks has
					// to resolve back to the bundle row.
					conversationBundleId: metadata?.conversationBundleId,
					parentContextId: metadata?.parentContextId,
				},
			});

			if (!firstQdrantId) {
				firstQdrantId = qdrantId;
			}
			successCount++;
		} catch (error) {
			const errorMsg =
				error instanceof Error ? error.message : String(error);
			logger.error(
				`[AutoEmbed] Failed to embed chunk ${chunk.index}: ${errorMsg}`,
			);
			errors.push(`Chunk ${chunk.index}: ${errorMsg}`);
		}
	}

	if (successCount === 0) {
		const errorDetail = errors.length > 0 ? `: ${errors[0]}` : "";
		return {
			success: false,
			error: `Failed to embed any chunks${errorDetail}`,
		};
	}

	// Update database with embedding status (use first chunk's ID).
	// See `skipDbUpdate` doc in EmbedContextOptions.
	if (firstQdrantId && !skipDbUpdate) {
		await markContextAsEmbedded(contextId, firstQdrantId);
	}

	logger.info(
		`[AutoEmbed] Successfully embedded context ${contextId}: ${successCount}/${enrichedChunks.length} chunks`,
	);

	return {
		success: true,
		qdrantId: firstQdrantId,
		chunksCreated: successCount,
	};
}

/**
 * Re-embed a context after content update
 *
 * This removes the old embedding and creates a new one.
 *
 * @param options - Embed options with new content
 * @returns Embed result
 */
export async function reembedProjectContext(
	options: EmbedContextOptions,
): Promise<EmbedResult> {
	const { contextId, organizationId } = options;

	logger.info(`[AutoEmbed] Re-embedding context ${contextId}`);

	try {
		// Delete old embedding (ignore errors if it doesn't exist)
		try {
			await deleteProjectContext(contextId, organizationId);
		} catch {
			logger.debug(
				`[AutoEmbed] No existing embedding to delete for ${contextId}`,
			);
		}

		// Create new embedding
		return await embedProjectContext(options);
	} catch (error) {
		const errorMessage =
			error instanceof Error ? error.message : "Unknown error";
		logger.error(
			`[AutoEmbed] Failed to re-embed context ${contextId}: ${errorMessage}`,
		);

		return {
			success: false,
			error: errorMessage,
		};
	}
}

/**
 * Remove embedding for a deleted context
 *
 * @param contextId - ID of the deleted context
 * @param organizationId - Organization ID for routing to correct collection
 */
export async function removeContextEmbedding(
	contextId: string,
	organizationId?: string,
): Promise<void> {
	logger.info(`[AutoEmbed] Removing embedding for context ${contextId}`);

	try {
		await deleteProjectContext(contextId, organizationId);
		logger.info(`[AutoEmbed] Removed embedding for context ${contextId}`);
	} catch (error) {
		// Log but don't throw - context is already deleted
		logger.warn(
			`[AutoEmbed] Failed to remove embedding for ${contextId}: ${error}`,
		);
	}
}

/**
 * Batch embed multiple contexts
 *
 * @param contexts - Array of contexts to embed
 * @returns Array of embed results
 */
export async function batchEmbedContexts(
	contexts: EmbedContextOptions[],
): Promise<EmbedResult[]> {
	logger.info(`[AutoEmbed] Batch embedding ${contexts.length} contexts`);

	const results: EmbedResult[] = [];

	// Process in batches to avoid overwhelming the embedding API
	const batchSize = 5;

	for (let i = 0; i < contexts.length; i += batchSize) {
		const batch = contexts.slice(i, i + batchSize);

		const batchResults = await Promise.all(
			batch.map((ctx) => embedProjectContext(ctx)),
		);

		results.push(...batchResults);
	}

	const successCount = results.filter((r) => r.success).length;
	logger.info(
		`[AutoEmbed] Batch complete: ${successCount}/${contexts.length} succeeded`,
	);

	return results;
}
