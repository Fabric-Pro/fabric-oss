/**
 * Vector store operations for workspace documents using Qdrant
 * Handles storing and retrieving workspace document embeddings
 *
 * MULTI-TENANCY:
 * - Personal data (organizationId = null): Stored in shared 'workspace-documents' collection
 * - Organization data: Stored in dedicated 'workspace-documents-org-{orgId}' collections
 * - This provides complete physical isolation between organizations
 */

import { logger } from "@repo/logs";
import {
	type CollectionLayout,
	ensureCollection as ensureCollectionExists,
	getCollectionLayout,
} from "../collection-manager";
import { generateSparseVector } from "../embedding/sparse";
import { generatePointId } from "../utils";
import { qdrantClient } from "./client";
import type {
	BulkStoreOptions,
	MultiWorkspaceSearchOptions,
	WorkspaceChunkStoreOptions,
	WorkspaceRetrievalResult,
	WorkspaceSearchOptions,
} from "./types";

/**
 * Ensure collection exists for the given organization context
 * Uses the collection manager for lazy creation and caching
 *
 * @param organizationId - Optional organization ID for org-specific collections
 * @returns The collection name
 */
async function ensureCollection(organizationId?: string): Promise<string> {
	return ensureCollectionExists("workspace-documents", organizationId);
}

function buildPointVector(
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

async function searchWithLayout(params: {
	layout: CollectionLayout;
	collectionName: string;
	queryEmbedding: number[];
	querySparseVector?: { indices: number[]; values: number[] };
	enableHybrid?: boolean;
	topK: number;
	minSimilarity: number;
	filter: Record<string, unknown>;
}): Promise<
	Array<{
		id: string | number;
		score: number;
		payload?: Record<string, unknown> | null;
	}>
> {
	const {
		layout,
		collectionName,
		queryEmbedding,
		querySparseVector,
		enableHybrid,
		topK,
		minSimilarity,
		filter,
	} = params;

	if ((enableHybrid ?? true) && layout.supportsHybrid && querySparseVector) {
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
						query: querySparseVector,
						using: layout.sparseVectorName ?? "sparse",
						limit: topK * 2,
						filter,
					},
				],
				query: { fusion: "rrf" },
				limit: topK,
				with_payload: true,
			});

			return hybridResults.points;
		} catch (error) {
			logger.warn(
				`[WorkspaceDocumentStore] Hybrid search failed, falling back to dense-only: ${error}`,
			);
		}
	}

	try {
		const vector = layout.denseVectorName
			? { name: layout.denseVectorName, vector: queryEmbedding }
			: queryEmbedding;

		return await qdrantClient.search(collectionName, {
			vector,
			limit: topK,
			score_threshold: minSimilarity,
			filter,
		});
	} catch (error) {
		logger.warn(
			`[WorkspaceDocumentStore] Dense search fallback triggered: ${error}`,
		);
		// Bare-vector retry for legacy unnamed-vector collections.
		return qdrantClient.search(collectionName, {
			vector: queryEmbedding,
			limit: topK,
			score_threshold: minSimilarity,
			filter,
		});
	}
}

/**
 * Store a workspace document chunk with its embedding in Qdrant
 *
 * @param options - Store options
 * @returns Qdrant point ID
 */
export async function storeWorkspaceChunk(
	options: WorkspaceChunkStoreOptions,
): Promise<string> {
	const {
		chunkId,
		documentId,
		workspaceId,
		userId,
		organizationId,
		content,
		chunkIndex,
		embedding,
		filename,
		pageNumber,
		headings,
	} = options;

	logger.info(
		`[WorkspaceDocumentStore] Storing chunk ${chunkIndex} for document ${documentId} in workspace ${workspaceId}`,
	);

	try {
		// Get the appropriate collection (org-specific or shared)
		const collectionName = await ensureCollection(organizationId);
		const layout = await getCollectionLayout(
			"workspace-documents",
			organizationId,
		);

		// Generate deterministic point ID from chunkId
		const pointId = generatePointId(chunkId);

		// Build payload - only include defined values
		const payload: Record<string, unknown> = {
			chunkId,
			documentId,
			workspaceId,
			userId,
			chunkIndex,
		};

		if (organizationId) {
			payload.organizationId = organizationId;
		}
		if (filename) {
			payload.filename = filename;
		}
		if (pageNumber !== undefined) {
			payload.pageNumber = pageNumber;
		}
		if (headings && headings.length > 0) {
			payload.headings = headings;
		}

		// Store content preview for debugging (first 200 chars)
		payload.contentPreview = content.slice(0, 200);
		payload.createdAt = new Date().toISOString();

		// Store in Qdrant (org-specific or shared collection)
		await qdrantClient.upsert(collectionName, {
			wait: true,
			points: [
				{
					id: pointId,
					vector: buildPointVector(
						layout,
						embedding,
						content,
						options.sparseVector,
					),
					payload,
				},
			],
		});

		logger.info(
			`[WorkspaceDocumentStore] Chunk stored successfully with point ID: ${pointId} in collection: ${collectionName}`,
		);

		return pointId;
	} catch (error) {
		logger.error(
			`[WorkspaceDocumentStore] Failed to store chunk: ${error}`,
		);
		throw new Error(
			`Failed to store workspace chunk: ${error instanceof Error ? error.message : "Unknown error"}`,
		);
	}
}

/**
 * Store multiple chunks in a single batch operation
 * More efficient than individual stores
 *
 * @param options - Bulk store options
 * @returns Array of point IDs
 */
export async function storeWorkspaceChunksBatch(
	options: BulkStoreOptions,
): Promise<string[]> {
	const { chunks, wait = true } = options;

	if (chunks.length === 0) {
		return [];
	}

	// All chunks in a batch must belong to the same organization
	// Get organizationId from first chunk (all should have same value)
	const organizationId = chunks[0]?.organizationId;

	logger.info(
		`[WorkspaceDocumentStore] Storing ${chunks.length} chunks in batch`,
	);

	try {
		// Get the appropriate collection (org-specific or shared)
		const collectionName = await ensureCollection(organizationId);
		const layout = await getCollectionLayout(
			"workspace-documents",
			organizationId,
		);

		const points = chunks.map((chunk) => {
			const pointId = generatePointId(chunk.chunkId);

			const payload: Record<string, unknown> = {
				chunkId: chunk.chunkId,
				documentId: chunk.documentId,
				workspaceId: chunk.workspaceId,
				userId: chunk.userId,
				chunkIndex: chunk.chunkIndex,
			};

			if (chunk.organizationId) {
				payload.organizationId = chunk.organizationId;
			}
			if (chunk.filename) {
				payload.filename = chunk.filename;
			}
			if (chunk.pageNumber !== undefined) {
				payload.pageNumber = chunk.pageNumber;
			}
			if (chunk.headings && chunk.headings.length > 0) {
				payload.headings = chunk.headings;
			}
			payload.contentPreview = chunk.content.slice(0, 200);
			payload.createdAt = new Date().toISOString();

			return {
				id: pointId,
				vector: buildPointVector(
					layout,
					chunk.embedding,
					chunk.content,
					chunk.sparseVector,
				),
				payload,
			};
		});

		// Upsert in batches of 100 to avoid overwhelming Qdrant
		const batchSize = 100;
		const pointIds: string[] = [];

		for (let i = 0; i < points.length; i += batchSize) {
			const batch = points.slice(i, i + batchSize);
			await qdrantClient.upsert(collectionName, {
				wait,
				points: batch,
			});
			pointIds.push(...batch.map((p) => p.id as string));
		}

		logger.info(
			`[WorkspaceDocumentStore] Successfully stored ${chunks.length} chunks in collection: ${collectionName}`,
		);

		return pointIds;
	} catch (error) {
		logger.error(
			`[WorkspaceDocumentStore] Failed to store chunks batch: ${error}`,
		);
		throw new Error(
			`Failed to store workspace chunks batch: ${error instanceof Error ? error.message : "Unknown error"}`,
		);
	}
}

/**
 * Search for similar chunks within a workspace
 *
 * Security Model:
 * - Access is verified at the API layer via hasWorkspaceAccess() BEFORE calling this function
 * - Physical isolation: Org data in org-specific collection, personal data in shared collection
 * - Qdrant filtering uses workspaceId as secondary isolation within the collection
 *
 * @param options - Search options
 * @returns Array of retrieval results
 */
export async function searchWorkspaceChunks(
	options: WorkspaceSearchOptions,
): Promise<WorkspaceRetrievalResult[]> {
	const {
		workspaceId,
		userId, // Used for defense-in-depth filtering in personal workspaces
		organizationId,
		queryEmbedding,
		querySparseVector,
		topK = 5,
		minSimilarity = 0.5,
		documentIds,
		enableHybrid,
	} = options;

	logger.info(
		`[WorkspaceDocumentStore] Searching workspace ${workspaceId} (topK=${topK}, minSimilarity=${minSimilarity})`,
	);

	try {
		// Get the appropriate collection (org-specific or shared)
		// This provides physical isolation between organizations
		const collectionName = await ensureCollection(organizationId);
		const layout = await getCollectionLayout(
			"workspace-documents",
			organizationId,
		);

		// Debug: Check if any points exist for this workspace
		const countResult = await qdrantClient.count(collectionName, {
			filter: {
				must: [
					{
						key: "workspaceId",
						match: { value: workspaceId },
					},
				],
			},
			exact: true,
		});
		logger.info(
			`[WorkspaceDocumentStore] Workspace ${workspaceId} has ${countResult.count} points in collection ${collectionName}`,
		);

		// Build filter with defense-in-depth tenant isolation
		// Physical isolation (separate collections) provides primary protection
		// workspaceId provides secondary isolation within the collection
		const filter: any = {
			must: [
				{
					key: "workspaceId",
					match: { value: workspaceId },
				},
			],
		};

		// Defense-in-depth: For personal workspaces (no organizationId), also filter by userId
		// This ensures that even if workspace access control is bypassed at the API layer,
		// users can only query their own personal workspace documents in the shared collection
		if (!organizationId && userId) {
			filter.must.push({
				key: "userId",
				match: { value: userId },
			});
		}

		// Add specific document IDs filter if provided
		if (documentIds && documentIds.length > 0) {
			filter.must.push({
				key: "documentId",
				match: { any: documentIds },
			});
		}

		// Search Qdrant (org-specific or shared collection)
		const searchResult = await searchWithLayout({
			layout,
			collectionName,
			queryEmbedding,
			querySparseVector,
			enableHybrid,
			topK,
			minSimilarity,
			filter,
		});

		if (searchResult.length === 0) {
			logger.info("[WorkspaceDocumentStore] No similar chunks found");
			return [];
		}

		// Map results to retrieval format
		const results: WorkspaceRetrievalResult[] = searchResult.map(
			(result) => ({
				chunkId: result.payload?.chunkId as string,
				documentId: result.payload?.documentId as string,
				workspaceId: result.payload?.workspaceId as string,
				score: result.score,
				filename: result.payload?.filename as string | undefined,
				chunkIndex: result.payload?.chunkIndex as number,
				pageNumber: result.payload?.pageNumber as number | undefined,
				headings: result.payload?.headings as string[] | undefined,
			}),
		);

		logger.info(
			`[WorkspaceDocumentStore] Found ${results.length} similar chunks`,
		);

		return results;
	} catch (error) {
		logger.error(
			`[WorkspaceDocumentStore] Failed to search chunks: ${error}`,
		);
		throw new Error(
			`Failed to search workspace chunks: ${error instanceof Error ? error.message : "Unknown error"}`,
		);
	}
}

/**
 * Search for similar chunks across multiple workspaces
 * Used when a conversation has multiple workspaces attached
 *
 * Security Model:
 * - Physical isolation: Org data in org-specific collection, personal data in shared collection
 * - All workspaces in a search must belong to the same context (org or personal)
 * - The API layer validates workspace access before calling this function
 *
 * @param options - Multi-workspace search options
 * @returns Array of retrieval results
 */
export async function searchMultipleWorkspaces(
	options: MultiWorkspaceSearchOptions,
): Promise<WorkspaceRetrievalResult[]> {
	const {
		workspaceIds,
		userId, // Used for defense-in-depth filtering in personal workspaces
		organizationId, // Used to determine which collection to search
		queryEmbedding,
		querySparseVector,
		topK = 5,
		minSimilarity = 0.3, // Lower default for better recall
		documentIds,
		enableHybrid,
	} = options;

	if (workspaceIds.length === 0) {
		logger.info("[WorkspaceDocumentStore] No workspaces to search");
		return [];
	}

	logger.info(
		`[WorkspaceDocumentStore] Searching across ${workspaceIds.length} workspaces`,
		{ workspaceIds, topK, minSimilarity, organizationId },
	);

	try {
		// Get the appropriate collection (org-specific or shared)
		// All workspaces in the search must belong to the same context
		const collectionName = await ensureCollection(organizationId);
		const layout = await getCollectionLayout(
			"workspace-documents",
			organizationId,
		);

		// Build filter with defense-in-depth tenant isolation
		// Physical isolation (separate collections) provides primary protection
		// workspaceIds provide secondary isolation within the collection
		const filter: any = {
			must: [
				{
					key: "workspaceId",
					match: { any: workspaceIds },
				},
			],
		};

		// Defense-in-depth: For personal workspaces (no organizationId), also filter by userId
		// This ensures that even if workspace access control is bypassed at the API layer,
		// users can only query their own personal workspace documents in the shared collection
		if (!organizationId && userId) {
			filter.must.push({
				key: "userId",
				match: { value: userId },
			});
		}

		// Add specific document IDs filter if provided
		if (documentIds && documentIds.length > 0) {
			filter.must.push({
				key: "documentId",
				match: { any: documentIds },
			});
		}

		// Search Qdrant - multiply topK by workspace count to get good coverage
		const adjustedTopK = Math.min(topK * workspaceIds.length, 50);

		logger.info("[WorkspaceDocumentStore] Executing Qdrant search", {
			adjustedTopK,
			minSimilarity,
			collectionName,
			filter: JSON.stringify(filter),
		});

		const searchResult = await searchWithLayout({
			layout,
			collectionName,
			queryEmbedding,
			querySparseVector,
			enableHybrid,
			topK: adjustedTopK,
			minSimilarity,
			filter,
		});

		logger.info("[WorkspaceDocumentStore] Qdrant search completed", {
			resultCount: searchResult.length,
		});

		if (searchResult.length === 0) {
			logger.info("[WorkspaceDocumentStore] No similar chunks found");
			return [];
		}

		// Map results to retrieval format
		const results: WorkspaceRetrievalResult[] = searchResult.map(
			(result) => ({
				chunkId: result.payload?.chunkId as string,
				documentId: result.payload?.documentId as string,
				workspaceId: result.payload?.workspaceId as string,
				score: result.score,
				filename: result.payload?.filename as string | undefined,
				chunkIndex: result.payload?.chunkIndex as number,
				pageNumber: result.payload?.pageNumber as number | undefined,
				headings: result.payload?.headings as string[] | undefined,
			}),
		);

		// Return top K overall
		const topResults = results.slice(0, topK);

		logger.info(
			`[WorkspaceDocumentStore] Found ${topResults.length} similar chunks across workspaces`,
			{ topScores: topResults.slice(0, 3).map((r) => r.score) },
		);

		return topResults;
	} catch (error) {
		logger.error(
			`[WorkspaceDocumentStore] Failed to search multiple workspaces: ${error}`,
		);
		throw new Error(
			`Failed to search multiple workspaces: ${error instanceof Error ? error.message : "Unknown error"}`,
		);
	}
}

/**
 * Delete all chunks for a workspace document
 *
 * @param documentId - Document ID
 * @param workspaceId - Workspace ID (for safety)
 * @param organizationId - Organization ID (determines which collection to use)
 */
export async function deleteWorkspaceDocumentChunks(
	documentId: string,
	workspaceId: string,
	organizationId?: string,
): Promise<void> {
	logger.info(
		`[WorkspaceDocumentStore] Deleting chunks for document: ${documentId}`,
	);

	try {
		// Get the appropriate collection (org-specific or shared)
		const collectionName = await ensureCollection(organizationId);

		// Delete using filter to ensure we only delete from the correct workspace
		await qdrantClient.delete(collectionName, {
			wait: true,
			filter: {
				must: [
					{
						key: "documentId",
						match: { value: documentId },
					},
					{
						key: "workspaceId",
						match: { value: workspaceId },
					},
				],
			},
		});

		logger.info(
			`[WorkspaceDocumentStore] Chunks deleted for document: ${documentId} from collection: ${collectionName}`,
		);
	} catch (error) {
		logger.error(
			`[WorkspaceDocumentStore] Failed to delete document chunks: ${error}`,
		);
		throw new Error(
			`Failed to delete document chunks: ${error instanceof Error ? error.message : "Unknown error"}`,
		);
	}
}

/**
 * Delete all chunks for a workspace
 *
 * @param workspaceId - Workspace ID
 * @param organizationId - Organization ID (determines which collection to use)
 */
export async function deleteAllWorkspaceChunks(
	workspaceId: string,
	organizationId?: string,
): Promise<void> {
	logger.info(
		`[WorkspaceDocumentStore] Deleting all chunks for workspace: ${workspaceId}`,
	);

	try {
		// Get the appropriate collection (org-specific or shared)
		const collectionName = await ensureCollection(organizationId);

		const filter: any = {
			must: [
				{
					key: "workspaceId",
					match: { value: workspaceId },
				},
			],
		};

		await qdrantClient.delete(collectionName, {
			wait: true,
			filter,
		});

		logger.info(
			`[WorkspaceDocumentStore] All chunks deleted for workspace: ${workspaceId} from collection: ${collectionName}`,
		);
	} catch (error) {
		logger.error(
			`[WorkspaceDocumentStore] Failed to delete workspace chunks: ${error}`,
		);
		throw new Error(
			`Failed to delete workspace chunks: ${error instanceof Error ? error.message : "Unknown error"}`,
		);
	}
}

/**
 * Delete specific chunks by their IDs
 *
 * @param chunkIds - Array of chunk IDs
 * @param organizationId - Organization ID (determines which collection to use)
 */
export async function deleteChunksByIds(
	chunkIds: string[],
	organizationId?: string,
): Promise<void> {
	if (chunkIds.length === 0) {
		return;
	}

	logger.info(
		`[WorkspaceDocumentStore] Deleting ${chunkIds.length} chunks by ID`,
	);

	try {
		// Get the appropriate collection (org-specific or shared)
		const collectionName = await ensureCollection(organizationId);

		// Convert chunk IDs to point IDs
		const pointIds = chunkIds.map(generatePointId);

		// Delete in batches of 100
		const batchSize = 100;
		for (let i = 0; i < pointIds.length; i += batchSize) {
			const batch = pointIds.slice(i, i + batchSize);
			await qdrantClient.delete(collectionName, {
				wait: true,
				points: batch,
			});
		}

		logger.info(
			`[WorkspaceDocumentStore] Deleted ${chunkIds.length} chunks from collection: ${collectionName}`,
		);
	} catch (error) {
		logger.error(
			`[WorkspaceDocumentStore] Failed to delete chunks by IDs: ${error}`,
		);
		throw new Error(
			`Failed to delete chunks by IDs: ${error instanceof Error ? error.message : "Unknown error"}`,
		);
	}
}

/**
 * Get chunk count for a workspace
 *
 * @param workspaceId - Workspace ID
 * @param organizationId - Organization ID (determines which collection to use)
 */
export async function getWorkspaceChunkCount(
	workspaceId: string,
	organizationId?: string,
): Promise<number> {
	try {
		// Get the appropriate collection (org-specific or shared)
		const collectionName = await ensureCollection(organizationId);

		const result = await qdrantClient.count(collectionName, {
			filter: {
				must: [
					{
						key: "workspaceId",
						match: { value: workspaceId },
					},
				],
			},
			exact: true,
		});

		return result.count;
	} catch (error) {
		logger.error(
			`[WorkspaceDocumentStore] Failed to count chunks: ${error}`,
		);
		throw new Error(
			`Failed to count workspace chunks: ${error instanceof Error ? error.message : "Unknown error"}`,
		);
	}
}

/**
 * Get chunk count for a document
 *
 * @param documentId - Document ID
 * @param organizationId - Organization ID (determines which collection to use)
 */
export async function getDocumentChunkCount(
	documentId: string,
	organizationId?: string,
): Promise<number> {
	try {
		// Get the appropriate collection (org-specific or shared)
		const collectionName = await ensureCollection(organizationId);

		const result = await qdrantClient.count(collectionName, {
			filter: {
				must: [
					{
						key: "documentId",
						match: { value: documentId },
					},
				],
			},
			exact: true,
		});

		return result.count;
	} catch (error) {
		logger.error(
			`[WorkspaceDocumentStore] Failed to count document chunks: ${error}`,
		);
		throw new Error(
			`Failed to count document chunks: ${error instanceof Error ? error.message : "Unknown error"}`,
		);
	}
}
