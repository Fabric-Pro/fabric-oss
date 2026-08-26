/**
 * Vector store operations using Qdrant
 * Handles storing and retrieving document chunks with embeddings
 *
 * Multi-tenancy:
 * - Personal data (organizationId = null): Shared collection with userId filtering
 * - Organization data: Dedicated collections per organization for physical isolation
 */

import type { Prisma } from "@repo/database";
import { db } from "@repo/database";
import { logger } from "@repo/logs";
import {
	type CollectionLayout,
	ensureCollection,
	getCollectionLayout,
} from "../collection-manager";
import { generateSparseVector } from "../embedding/sparse";
import { generatePointId } from "../utils";
import { qdrantClient } from "./client";
import type {
	RetrievalResult,
	SearchOptions,
	StoreChunkOptions,
} from "./types";

/**
 * Get the collection name for chat documents based on organization
 */
async function getChatCollection(
	organizationId?: string | null,
): Promise<string> {
	return ensureCollection("chat-documents", organizationId);
}

function buildChatPointVector(
	layout: CollectionLayout,
	embedding: number[],
	content: string,
	sparseVector?: { indices: number[]; values: number[] },
):
	| number[]
	| Record<string, number[] | { indices: number[]; values: number[] }> {
	const sparse = sparseVector ?? generateSparseVector(content);

	if (!layout.supportsHybrid) {
		return embedding;
	}

	if (layout.denseVectorName) {
		return {
			[layout.denseVectorName]: embedding,
			[layout.sparseVectorName ?? "sparse"]: sparse,
		};
	}

	return {
		"": embedding,
		[layout.sparseVectorName ?? "sparse"]: sparse,
	};
}

/**
 * Sanitize text content for PostgreSQL storage
 * Removes null bytes (0x00) which PostgreSQL doesn't accept in text fields
 */
function sanitizeForPostgres(text: string): string {
	// Remove null bytes that cause "invalid byte sequence for encoding UTF8: 0x00"
	// Also remove other problematic characters that might cause encoding issues
	// biome-ignore lint/suspicious/noControlCharactersInRegex: intentionally matching null bytes to sanitize PostgreSQL input
	return text.replace(/\u0000/g, "").replace(/\uFFFD/g, "");
}

/**
 * Recursively sanitize an object/value for PostgreSQL storage
 * Removes null bytes from all string values in the object tree
 */
function sanitizeMetadataForPostgres(value: unknown): unknown {
	if (value === null || value === undefined) {
		return value;
	}

	if (typeof value === "string") {
		return sanitizeForPostgres(value);
	}

	if (Array.isArray(value)) {
		return value.map(sanitizeMetadataForPostgres);
	}

	if (typeof value === "object") {
		const sanitized: Record<string, unknown> = {};
		for (const [key, val] of Object.entries(value)) {
			sanitized[key] = sanitizeMetadataForPostgres(val);
		}
		return sanitized;
	}

	return value;
}

/**
 * Store a document chunk with its embedding
 * Stores metadata in PostgreSQL and vector in Qdrant
 *
 * @param options - Store chunk options
 * @returns Created chunk ID
 */
export async function storeChunk(options: StoreChunkOptions): Promise<string> {
	const {
		documentId,
		chatId,
		userId,
		organizationId,
		content,
		chunkIndex,
		embedding,
		metadata,
	} = options;

	console.log(
		`[VectorStore] ========== STORING CHUNK ${chunkIndex} ==========`,
	);
	console.log("[VectorStore] documentId:", documentId);
	console.log("[VectorStore] chatId:", chatId);
	console.log("[VectorStore] userId:", userId);
	console.log("[VectorStore] organizationId:", organizationId);
	console.log("[VectorStore] chunkIndex:", chunkIndex);

	logger.info(
		`[VectorStore] Storing chunk ${chunkIndex} for document ${documentId}`,
	);

	try {
		// Get collection name (creates org-specific collection if needed)
		const collectionName = await getChatCollection(organizationId);
		const layout = await getCollectionLayout(
			"chat-documents",
			organizationId,
		);

		// Step 1: Store chunk metadata in PostgreSQL
		// Using raw db since create operations explicitly set userId/organizationId
		// and the Qdrant storage below uses explicit collection routing
		// Sanitize content and metadata to remove null bytes that PostgreSQL rejects
		const sanitizedContent = sanitizeForPostgres(content);
		const sanitizedMetadata = sanitizeMetadataForPostgres(metadata);
		const chunk = await db.documentChunk.create({
			data: {
				documentId,
				chatId,
				userId,
				organizationId: organizationId || null,
				content: sanitizedContent,
				chunkIndex,
				metadata: sanitizedMetadata as Prisma.InputJsonValue,
			},
		});

		// Step 2: Store vector embedding in Qdrant
		// Convert CUID to UUID format (Qdrant requirement)
		const qdrantPointId = generatePointId(chunk.id);

		// Build payload, omitting organizationId if undefined (Qdrant doesn't accept null/undefined)
		const payload: Record<string, unknown> = {
			chunkId: chunk.id, // Store original CUID for lookup
			documentId,
			chatId,
			userId,
			chunkIndex,
			// Store minimal metadata in Qdrant for filtering
			// Full content and metadata are in PostgreSQL
		};

		// Only include organizationId if it's defined and not null
		if (organizationId !== undefined && organizationId !== null) {
			payload.organizationId = organizationId;
		}

		console.log("[VectorStore] About to upsert to Qdrant");
		console.log("[VectorStore] Qdrant point ID:", qdrantPointId);
		console.log("[VectorStore] Vector length:", embedding.length);
		console.log(
			"[VectorStore] Sparse terms:",
			(options.sparseVector ?? generateSparseVector(content)).indices
				.length,
		);

		await qdrantClient.upsert(collectionName, {
			wait: true,
			points: [
				{
					id: qdrantPointId,
					vector: buildChatPointVector(
						layout,
						embedding,
						content,
						options.sparseVector,
					),
					payload,
				},
			],
		});

		console.log(
			`[VectorStore] Successfully stored in Qdrant with chatId: ${chatId}`,
		);
		logger.info(
			`[VectorStore] Stored chunk ${chunk.id} in PostgreSQL and Qdrant`,
		);

		return chunk.id;
	} catch (error) {
		console.error("[VectorStore] Qdrant upsert failed with error:", error);
		if (error instanceof Error) {
			console.error("[VectorStore] Error message:", error.message);
			console.error("[VectorStore] Error stack:", error.stack);
		}
		logger.error(`[VectorStore] Failed to store chunk: ${error}`);
		throw new Error(
			`Failed to store chunk: ${error instanceof Error ? error.message : "Unknown error"}`,
		);
	}
}

/**
 * Store multiple chunks in batch
 * More efficient than calling storeChunk multiple times
 *
 * @param chunks - Array of chunk options
 * @returns Array of created chunk IDs
 */
export async function storeChunks(
	chunks: StoreChunkOptions[],
): Promise<string[]> {
	logger.info(`[VectorStore] Storing ${chunks.length} chunks in batch`);

	const chunkIds: string[] = [];

	for (const chunk of chunks) {
		const id = await storeChunk(chunk);
		chunkIds.push(id);
	}

	logger.info(`[VectorStore] Stored ${chunkIds.length} chunks`);

	return chunkIds;
}

/**
 * Search for similar chunks using vector similarity
 * Searches Qdrant with multi-tenancy filtering, then enriches with PostgreSQL data
 *
 * Multi-tenancy:
 * - Physical isolation: Organization data is in separate collections
 * - Within collection: Filter by chatId, userId, and optional documentIds
 *
 * @param options - Search options
 * @returns Array of retrieval results
 */
export async function searchSimilarChunks(
	options: SearchOptions,
): Promise<RetrievalResult[]> {
	const {
		chatId,
		userId,
		organizationId,
		queryEmbedding,
		topK = 5,
		minSimilarity = 0.5, // Lowered from 0.7 to 0.5 for balanced recall/precision
		documentIds,
		explicitAttachment = false,
	} = options;

	// Explicitly-attached documents must always be readable by the model.
	// When a chat surface restricts the search to specific `documentIds` that the
	// user attached to their message (`explicitAttachment`), drop the
	// semantic-similarity floor: a document-Q&A question frequently embeds below
	// the 0.5 threshold, so applying the floor silently returns 0 chunks even
	// though the chunk is stored — which the user experiences as "the AI can't
	// see my attachment" (the PDF/Markdown Nexus attachment failure). `topK` still
	// bounds and ranks the result set, and the `documentId` filter already scopes
	// retrieval to exactly the attached files, so dropping the floor only ever
	// surfaces the user's own attached content. The floor still applies to
	// unscoped chat-wide retrieval AND to programmatic/scoped callers (e.g. the v1
	// knowledge API) that pass `documentIds` WITHOUT `explicitAttachment` and rely
	// on `minSimilarity` as a relevance gate.
	const hasExplicitDocumentFilter =
		Array.isArray(documentIds) && documentIds.length > 0;
	const effectiveMinSimilarity =
		hasExplicitDocumentFilter && explicitAttachment ? 0 : minSimilarity;

	logger.info(
		`[VectorStore] Searching for similar chunks in chat ${chatId} (topK=${topK}, minSimilarity=${minSimilarity}, effectiveMinSimilarity=${effectiveMinSimilarity})`,
	);
	if (documentIds && documentIds.length > 0) {
		logger.info(
			`[VectorStore] Filtering by specific documents: ${documentIds.join(", ")}`,
		);
	}
	console.log("[VectorStore] Search params:", {
		chatId,
		userId,
		organizationId,
		topK,
		minSimilarity,
		vectorDimensions: queryEmbedding.length,
		documentIds,
	});

	try {
		// Get collection name (org data is in separate collection = physical isolation)
		const collectionName = await getChatCollection(organizationId);
		const layout = await getCollectionLayout(
			"chat-documents",
			organizationId,
		);

		// First, let's check what's actually in Qdrant for this chat
		console.log(
			"[VectorStore] Checking Qdrant for points with this chatId...",
		);
		const scrollResult = await qdrantClient.scroll(collectionName, {
			limit: 100,
			with_payload: true,
			with_vector: false,
			filter: {
				must: [
					{
						key: "chatId",
						match: { value: chatId },
					},
				],
			},
		});
		console.log(
			`[VectorStore] Found ${scrollResult.points.length} points with chatId=${chatId}`,
		);
		if (scrollResult.points.length > 0) {
			console.log("[VectorStore] Sample point:", scrollResult.points[0]);
		}

		// Build filter for searching within the tenant's collection
		// Physical isolation (separate collections per org) provides primary security
		// This filter provides additional scoping within the collection:
		// - Personal context: Filter by chatId + userId
		// - Org context: Filter by chatId + organizationId
		const filter: any = {
			must: [
				{
					key: "chatId",
					match: { value: chatId },
				},
			],
		};

		if (organizationId) {
			// Organization context: filter by organizationId
			filter.must.push({
				key: "organizationId",
				match: { value: organizationId },
			});
		} else {
			// Personal context: filter by userId only
			// Physical collection isolation (separate collections per org) already prevents cross-org leakage
			// NOTE: We don't add is_null check for organizationId because:
			// 1. Personal data doesn't include organizationId field in payload (it's omitted, not null)
			// 2. Qdrant's is_null only matches fields that EXIST with null value, not missing fields
			// 3. This caused RAG to return 0 results for personal chats
			filter.must.push({
				key: "userId",
				match: { value: userId },
			});
		}

		// If specific document IDs are provided, add them to the filter
		if (documentIds && documentIds.length > 0) {
			// `should` nested in `must` has subtly different semantics
			// to `match.any` and can leak rows when composed with other
			// filter bugs — keep this as a simple AND-with-OR.
			filter.must.push({
				key: "documentId",
				match: { any: documentIds },
			});
			console.log("[VectorStore] Added documentIds filter:", documentIds);
		}

		// Check collection info
		const collectionInfo = await qdrantClient.getCollection(collectionName);
		console.log(
			`[VectorStore] Collection info: ${collectionInfo.points_count} points, vector size: ${collectionInfo.config.params.vectors?.size}`,
		);

		// Check what chatIds exist in the collection
		const allPointsSample = await qdrantClient.scroll(collectionName, {
			limit: 5,
			with_payload: true,
			with_vector: false,
		});
		console.log(
			"[VectorStore] Sample chatIds in collection:",
			allPointsSample.points.map((p) => p.payload?.chatId),
		);

		console.log("[VectorStore] Search parameters:");
		console.log(`  chatId: ${chatId}`);
		console.log(`  userId: ${userId}`);
		console.log(`  organizationId: ${organizationId}`);
		console.log(
			"[VectorStore] Search filter:",
			JSON.stringify(filter, null, 2),
		);
		console.log(
			`[VectorStore] Query embedding dimensions: ${queryEmbedding.length}`,
		);

		// First, let's try searching WITHOUT the filter AND without score threshold
		const searchResultNoFilter = await qdrantClient.search(collectionName, {
			vector: queryEmbedding,
			limit: topK,
			// Remove score_threshold to see ALL results
		});

		console.log(
			`[VectorStore] Search WITHOUT filter (no threshold) returned ${searchResultNoFilter.length} results`,
		);
		if (searchResultNoFilter.length > 0) {
			console.log(
				"[VectorStore] First result (no filter):",
				JSON.stringify(searchResultNoFilter[0], null, 2),
			);
		}

		// Try with a very low threshold
		const searchResultLowThreshold = await qdrantClient.search(
			collectionName,
			{
				vector: queryEmbedding,
				limit: topK,
				score_threshold: 0.1, // Very low threshold
			},
		);

		console.log(
			`[VectorStore] Search with threshold=0.1 returned ${searchResultLowThreshold.length} results`,
		);

		// Hybrid search: if sparse vector provided, use prefetch + RRF fusion
		// Otherwise fall back to standard dense-only search
		const useHybrid =
			(options.enableHybrid ?? true) && options.querySparseVector;

		let searchResult: Array<{
			id: string | number;
			score: number;
			payload?: Record<string, unknown> | null;
		}>;

		if (useHybrid && options.querySparseVector && layout.supportsHybrid) {
			console.log(
				"[VectorStore] Using HYBRID search (dense + sparse RRF)",
			);
			try {
				// Query API takes a bare VectorInput in prefetch.query; named-vector selection is via `using`.
				const densePrefetch = layout.denseVectorName
					? {
							query: queryEmbedding,
							using: layout.denseVectorName,
						}
					: {
							query: queryEmbedding,
						};

				const hybridResults = await qdrantClient.query(collectionName, {
					prefetch: [
						{
							...densePrefetch,
							limit: topK * 2,
							filter,
						},
						{
							query: options.querySparseVector,
							using: layout.sparseVectorName ?? "sparse",
							limit: topK * 2,
							filter,
						},
					],
					query: { fusion: "rrf" },
					limit: topK,
					with_payload: true,
				});
				searchResult = hybridResults.points;
				console.log(
					`[VectorStore] Hybrid search returned ${searchResult.length} results`,
				);
			} catch (hybridError) {
				console.warn(
					`[VectorStore] Hybrid search failed, falling back to dense-only: ${hybridError}`,
				);
				const vector = layout.denseVectorName
					? { name: layout.denseVectorName, vector: queryEmbedding }
					: queryEmbedding;
				searchResult = await qdrantClient.search(collectionName, {
					vector,
					limit: topK,
					score_threshold: effectiveMinSimilarity,
					filter,
				});
				console.log(
					`[VectorStore] Dense-only fallback returned ${searchResult.length} results`,
				);
			}
		} else {
			// Standard dense-only search (try named vector first, fall back to unnamed)
			try {
				const vector = layout.denseVectorName
					? { name: layout.denseVectorName, vector: queryEmbedding }
					: queryEmbedding;
				searchResult = await qdrantClient.search(collectionName, {
					vector,
					limit: topK,
					score_threshold: effectiveMinSimilarity,
					filter,
				});
			} catch {
				// Fall back to unnamed vector for legacy collections
				searchResult = await qdrantClient.search(collectionName, {
					vector: queryEmbedding,
					limit: topK,
					score_threshold: effectiveMinSimilarity,
					filter,
				});
			}
			console.log(
				`[VectorStore] Dense search returned ${searchResult.length} results`,
			);
		}

		if (searchResult.length === 0) {
			logger.info("[VectorStore] No similar chunks found");
			return [];
		}

		// Step 2: Get chunk IDs from Qdrant results (from payload, not point ID)
		const chunkIds = searchResult.map(
			(result) => result.payload?.chunkId as string,
		);

		// Step 3: Fetch full chunk data from PostgreSQL (with document info)
		// Use tenant-isolated db if context is available for defense-in-depth
		// We use raw db here since the tenant context filtering already happened via Qdrant
		// and the chunk IDs returned from Qdrant are pre-filtered by tenant context
		const chunks = await db.documentChunk.findMany({
			where: {
				id: { in: chunkIds },
			},
			include: {
				document: {
					select: {
						id: true,
						filename: true,
						status: true,
					},
				},
			},
		});

		// Filter out chunks from non-READY documents
		const readyChunks = chunks.filter(
			(chunk) => chunk.document.status === "READY",
		);

		// Step 4: Combine Qdrant scores with PostgreSQL data
		const results: RetrievalResult[] = readyChunks.map((chunk) => {
			const qdrantResult = searchResult.find(
				(result) => result.payload?.chunkId === chunk.id,
			);
			return {
				id: chunk.id,
				content: chunk.content,
				similarity: qdrantResult?.score || 0,
				documentId: chunk.documentId,
				filename: chunk.document.filename,
				metadata: chunk.metadata as Record<string, unknown>,
			};
		});

		// Sort by similarity (highest first)
		results.sort((a, b) => b.similarity - a.similarity);

		logger.info(`[VectorStore] Found ${results.length} similar chunks`);

		return results;
	} catch (error) {
		logger.error(`[VectorStore] Failed to search chunks: ${error}`);
		throw new Error(
			`Failed to search chunks: ${error instanceof Error ? error.message : "Unknown error"}`,
		);
	}
}

/**
 * Delete all chunks for a document
 * Deletes from both PostgreSQL and Qdrant
 *
 * @param documentId - Document ID
 * @param organizationId - Organization ID for routing to correct collection
 */
export async function deleteDocumentChunks(
	documentId: string,
	organizationId?: string | null,
): Promise<void> {
	logger.info(`[VectorStore] Deleting chunks for document ${documentId}`);

	try {
		// Get collection name (org data is in separate collection)
		const collectionName = await getChatCollection(organizationId);

		// Step 1: Get chunk IDs from PostgreSQL
		// Using raw db since delete operations require documentId which is a unique identifier
		// and the Qdrant deletion below uses explicit collection routing based on organizationId
		const chunks = await db.documentChunk.findMany({
			where: { documentId },
			select: { id: true },
		});

		const chunkIds = chunks.map((chunk) => chunk.id);

		if (chunkIds.length === 0) {
			logger.info(
				`[VectorStore] No chunks found for document ${documentId}`,
			);
			return;
		}

		// Step 2: Delete from Qdrant (convert CUIDs to UUIDs)
		const qdrantPointIds = chunkIds.map(generatePointId);
		await qdrantClient.delete(collectionName, {
			wait: true,
			points: qdrantPointIds,
		});

		// Step 3: Delete from PostgreSQL
		await db.documentChunk.deleteMany({
			where: { documentId },
		});

		logger.info(
			`[VectorStore] Deleted ${chunkIds.length} chunks for document ${documentId}`,
		);
	} catch (error) {
		logger.error(`[VectorStore] Failed to delete chunks: ${error}`);
		throw new Error(
			`Failed to delete chunks: ${error instanceof Error ? error.message : "Unknown error"}`,
		);
	}
}
