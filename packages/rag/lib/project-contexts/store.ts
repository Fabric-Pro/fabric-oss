/**
 * Vector store operations for project contexts using Qdrant
 * Handles storing and retrieving project context embeddings
 *
 * Multi-tenancy:
 * - Personal data (organizationId = null): Shared collection with userId filtering
 * - Organization data: Dedicated collections per organization for physical isolation
 */

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
	ProjectContextSearchOptions,
	ProjectContextStoreOptions,
	ProjectRetrievalResult,
} from "./types";

/**
 * Get the collection name for project contexts based on organization
 */
async function getProjectCollection(
	organizationId?: string | null,
): Promise<string> {
	return ensureCollection("project-contexts", organizationId);
}

/**
 * Qdrant point IDs must be either unsigned integers or UUIDs. Reject any
 * other string format (raw CUIDs, prefixed ids like "doc-…", etc.) before
 * sending to Qdrant — the entire request is rejected with 400 Bad Request
 * if any one ID in the list is malformed.
 */
const UUID_REGEX =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isValidQdrantPointId(id: string): boolean {
	if (UUID_REGEX.test(id)) {
		return true;
	}
	// Unsigned integer (no sign, no decimal)
	return /^[0-9]+$/.test(id);
}

function buildProjectPointVector(
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
 * Store a project context chunk with its embedding in Qdrant
 *
 * @param options - Store options
 * @returns Qdrant point ID
 */
export async function storeProjectContext(
	options: ProjectContextStoreOptions,
): Promise<string> {
	const {
		contextId,
		projectId,
		userId,
		organizationId,
		content,
		embedding,
		metadata,
	} = options;

	logger.info(
		`[ProjectContextStore] Storing context for project ${projectId}`,
	);

	try {
		// Get collection name (creates org-specific collection if needed)
		const collectionName = await getProjectCollection(organizationId);
		const layout = await getCollectionLayout(
			"project-contexts",
			organizationId,
		);

		// Generate deterministic point ID from contextId
		const pointId = generatePointId(contextId);

		const payload = {
			contextId,
			projectId,
			userId,
			organizationId: organizationId || null,
			type: metadata?.type || "unknown",
			filename: metadata?.filename,
			originalContextId: metadata?.originalContextId,
			provider: metadata?.provider || null,
			sourceUrl: metadata?.sourceUrl || null,
			sourceTitle: metadata?.sourceTitle || null,
			documentId: metadata?.documentId || null,
			documentType: metadata?.documentType || null,
			// OpenAPI spec chunks (Fizzy #2236). Present only on API_SPEC
			// contexts; every other point carries nulls here, so existing
			// points and existing filters are unaffected. These make an
			// endpoint chunk identifiable without re-reading its text --
			// which is what lets a multi-spec project tell "the legacy
			// system exposes X" apart from "the new API needs Y".
			specTitle: metadata?.specTitle || null,
			specVersion: metadata?.specVersion || null,
			specChunkKind: metadata?.specChunkKind || null,
			httpMethod: metadata?.httpMethod || null,
			path: metadata?.path || null,
			operationId: metadata?.operationId || null,
			operationTags: metadata?.operationTags || null,
			// Captured conversation bundles (Fizzy #2228). A monitored channel's
			// messages live in `ProjectContextConversationBundle`, not in the
			// channel's `ProjectContext` pointer row, so a hit on one of these
			// points has to be refetched from a different table — and the point
			// is the only thing that knows which. Null on every other point, so
			// existing points and existing filters are unaffected.
			//
			// Deliberately NOT declared as a payload index: it is read off the
			// search result and never filtered on. Only indexed keys may appear
			// in a delete-by-filter (Qdrant answers 400 otherwise), and the
			// channel-unlink delete reaches these same points through the
			// already-indexed `contextId` / `originalContextId` instead.
			conversationBundleId: metadata?.conversationBundleId || null,
			// The bundle's channel — a grouping key back to the pointer row,
			// read the same way and filtered on just as little.
			parentContextId: metadata?.parentContextId || null,
			// Store the chunk text in the payload so retrieval can return the
			// actual matched passage (via searchSimilarProjectContexts) instead
			// of re-fetching the entire parent document from Postgres. Adds ~1
			// KB per chunk; Qdrant storage is dominated by vectors, not payload.
			content,
			// Version of the source ProjectDocument at the time of embedding.
			// Used by the zombie-sweep workflow to find and delete chunks
			// that were upserted by a superseded embed run (their version
			// will be < the document's current version). See
			// projectDocumentEmbeddingSweepWorkflow.
			documentVersion:
				typeof metadata?.documentVersion === "number"
					? metadata.documentVersion
					: null,
			createdAt: new Date().toISOString(),
		};

		await qdrantClient.upsert(collectionName, {
			wait: true,
			points: [
				{
					id: pointId,
					vector: buildProjectPointVector(
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
			`[ProjectContextStore] Context stored successfully with point ID: ${pointId}`,
		);

		return pointId;
	} catch (error) {
		logger.error(`[ProjectContextStore] Failed to store context: ${error}`);
		throw new Error(
			`Failed to store project context: ${error instanceof Error ? error.message : "Unknown error"}`,
		);
	}
}

/**
 * Search for similar contexts using vector similarity
 * Searches Qdrant with project-level filtering
 *
 * Security Model:
 * - Physical isolation: Organization data is in separate collections
 * - Access is verified at the API layer via hasProjectAccess() BEFORE calling this function
 * - Qdrant filtering uses projectId as the primary isolation key within the collection
 * - For organization projects: any org member with project access can retrieve
 * - For personal projects: only the owner can retrieve (enforced at API layer)
 * - userId is stored for tracking who added content, not for filtering
 *
 * @param options - Search options
 * @returns Array of retrieval results
 */
export async function searchSimilarProjectContexts(
	options: ProjectContextSearchOptions,
): Promise<ProjectRetrievalResult[]> {
	const {
		projectId,
		userId: _userId, // Kept for logging/tracking but not used in filter
		organizationId,
		queryEmbedding,
		topK = 5,
		minSimilarity = 0.5,
		contextIds,
		excludeDocumentChunks = false,
	} = options;

	logger.info(
		`[ProjectContextStore] Searching for similar contexts in project ${projectId} (topK=${topK}, minSimilarity=${minSimilarity})`,
	);

	try {
		// Get collection name (org data is in separate collection = physical isolation)
		const collectionName = await getProjectCollection(organizationId);
		const layout = await getCollectionLayout(
			"project-contexts",
			organizationId,
		);

		// Build filter with defense-in-depth tenant isolation
		// Physical isolation (separate collections) provides primary protection
		// projectId provides secondary isolation within the collection
		// Access control is enforced at the API layer via hasProjectAccess()
		const filter: any = {
			must: [
				{
					key: "projectId",
					match: { value: projectId },
				},
			],
		};

		// For org projects, scope to org (additional safety layer)
		// For personal projects, add explicit is_null check to prevent cross-context leakage
		if (organizationId) {
			filter.must.push({
				key: "organizationId",
				match: { value: organizationId },
			});
		} else {
			// Personal context: ensure organizationId is null
			filter.must.push({
				is_null: { key: "organizationId" },
			});
		}

		// Add specific context IDs filter if provided
		if (contextIds && contextIds.length > 0) {
			filter.must.push({
				key: "contextId",
				match: { any: contextIds },
			});
		}

		// Source-only retrieval: keep only points that did NOT come from a
		// ProjectDocument. `storeProjectContext` writes
		// `documentId: metadata?.documentId || null`, and only document chunks
		// populate it — so `documentId IS NULL` is an exact discriminator that does
		// not depend on enumerating document types.
		//
		// Filtering on the `DOCUMENT_*` payload `type` prefix would have been the
		// obvious move, and it is wrong: it cannot tell an AI-generated document
		// from a user-uploaded one (both are ProjectDocument rows), so it would
		// silently discard legitimately imported source documents.
		if (excludeDocumentChunks) {
			filter.must.push({
				is_null: { key: "documentId" },
			});
		}

		// Hybrid search: use prefetch + RRF if sparse vector available
		let searchResult: Array<{
			id: string | number;
			score: number;
			payload?: Record<string, unknown> | null;
		}>;

		if (options.querySparseVector && layout.supportsHybrid) {
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
			} catch (hybridError) {
				console.warn(
					`[ProjectContextStore] Hybrid search failed, falling back to dense-only: ${hybridError}`,
				);
				const vector = layout.denseVectorName
					? { name: layout.denseVectorName, vector: queryEmbedding }
					: queryEmbedding;
				searchResult = await qdrantClient.search(collectionName, {
					vector,
					limit: topK,
					score_threshold: minSimilarity,
					filter,
				});
			}
		} else {
			// Dense-only search (try named vector, fall back to unnamed)
			try {
				const vector = layout.denseVectorName
					? { name: layout.denseVectorName, vector: queryEmbedding }
					: queryEmbedding;
				searchResult = await qdrantClient.search(collectionName, {
					vector,
					limit: topK,
					score_threshold: minSimilarity,
					filter,
				});
			} catch {
				searchResult = await qdrantClient.search(collectionName, {
					vector: queryEmbedding,
					limit: topK,
					score_threshold: minSimilarity,
					filter,
				});
			}
		}

		if (searchResult.length === 0) {
			logger.info("[ProjectContextStore] No similar contexts found");
			return [];
		}

		// Map results to retrieval format
		// Use originalContextId (base context ID) for DB lookup when available,
		// since chunked contexts have IDs like "contextId-chunk-0" which won't
		// match the ProjectContext table's primary key
		const results: ProjectRetrievalResult[] = searchResult.map(
			(result) => ({
				contextId:
					(result.payload?.originalContextId as string) ||
					(result.payload?.contextId as string),
				projectId: result.payload?.projectId as string,
				score: result.score,
				type: result.payload?.type as string,
				filename: result.payload?.filename as string | undefined,
				content: result.payload?.content as string | undefined,
				// Present only on captured-conversation points; tells the
				// refetch to look in the bundle table rather than in
				// `ProjectContext`.
				conversationBundleId:
					(result.payload?.conversationBundleId as
						| string
						| null
						| undefined) ?? undefined,
			}),
		);

		logger.info(
			`[ProjectContextStore] Found ${results.length} similar contexts`,
		);

		return results;
	} catch (error) {
		logger.error(
			`[ProjectContextStore] Failed to search contexts: ${error}`,
		);
		throw new Error(
			`Failed to search project contexts: ${error instanceof Error ? error.message : "Unknown error"}`,
		);
	}
}

/**
 * Delete a project context from Qdrant
 *
 * Uses filter-based deletion to handle any number of chunks:
 * - Deletes by originalContextId payload field (catches all chunks)
 * - Also deletes by contextId for single-chunk contexts
 * - Falls back to point ID deletion for legacy formats
 *
 * @param contextId - Context ID (used for filter-based deletion)
 * @param organizationId - Organization ID for routing to correct collection
 * @param qdrantId - Optional: The stored Qdrant point ID (for legacy support)
 */
export async function deleteProjectContext(
	contextId: string,
	organizationId?: string | null,
	qdrantId?: string,
): Promise<void> {
	logger.info(`[ProjectContextStore] Deleting context: ${contextId}`);

	try {
		// Get collection name (org data is in separate collection)
		const collectionName = await getProjectCollection(organizationId);

		// Step 1: Delete by filter using originalContextId (handles all chunks regardless of count)
		// Chunks are stored with originalContextId in payload pointing to the base contextId
		try {
			await qdrantClient.delete(collectionName, {
				wait: true,
				filter: {
					should: [
						{
							key: "originalContextId",
							match: { value: contextId },
						},
						{
							key: "contextId",
							match: { value: contextId },
						},
					],
				},
			});
			logger.info(
				`[ProjectContextStore] Filter-based deletion completed for context: ${contextId}`,
			);
		} catch (filterError) {
			// Filter deletion may fail if fields don't exist in older data
			// Continue to point-based deletion as fallback
			logger.warn(
				`[ProjectContextStore] Filter deletion failed, falling back to point IDs: ${filterError}`,
			);
		}

		// Step 2: Also try point ID deletion for legacy formats (UUID hash)
		// This handles points that may not have originalContextId field.
		//
		// Qdrant only accepts point IDs that are unsigned integers or UUIDs —
		// any other string (e.g. a raw CUID like "doc-cmmnnugls…") causes the
		// entire delete request to fail with 400 Bad Request. Only push IDs
		// that match those formats.
		const pointIds: string[] = [];

		// If a stored qdrantId was provided and looks valid, use it.
		if (qdrantId && isValidQdrantPointId(qdrantId)) {
			pointIds.push(qdrantId);
		}

		// Always include the deterministic UUID hash derived from the contextId.
		const generatedId = generatePointId(contextId);
		if (!pointIds.includes(generatedId)) {
			pointIds.push(generatedId);
		}

		// Delete legacy format points (Qdrant ignores non-existent IDs)
		if (pointIds.length > 0) {
			await qdrantClient.delete(collectionName, {
				wait: true,
				points: pointIds,
			});
		}

		logger.info(
			`[ProjectContextStore] Context deleted successfully: ${contextId}`,
		);
	} catch (error) {
		logger.error(
			`[ProjectContextStore] Failed to delete context: ${error}`,
		);
		throw new Error(
			`Failed to delete project context: ${error instanceof Error ? error.message : "Unknown error"}`,
		);
	}
}

/**
 * Delete stale project-document chunks in Qdrant whose `documentVersion`
 * payload has fallen behind the source `ProjectDocument.version`.
 *
 * Called by the zombie-sweep workflow to reap stragglers that were
 * upserted by a superseded embed run (e.g. an activity that was still
 * in flight when the workflow got TERMINATE_EXISTING-d on a rapid save).
 * Those stragglers share the same `originalContextId` as the current
 * chunks but hold a lower `documentVersion`; this helper builds a
 * filter-based delete that matches exactly that set.
 *
 * Returns the number of operation requests issued (for observability).
 */
export async function deleteStaleDocumentEmbeddingChunks(params: {
	documentId: string;
	currentVersion: number;
	organizationId?: string | null;
}): Promise<void> {
	const { documentId, currentVersion, organizationId } = params;
	const originalContextId = `doc-${documentId}`;

	logger.info(
		`[ProjectContextStore] Sweeping stale document chunks for ${documentId} (currentVersion=${currentVersion})`,
	);

	try {
		const collectionName = await getProjectCollection(organizationId);
		await qdrantClient.delete(collectionName, {
			wait: true,
			filter: {
				must: [
					{
						key: "originalContextId",
						match: { value: originalContextId },
					},
					{
						key: "documentVersion",
						range: { lt: currentVersion },
					},
				],
			},
		});
		logger.info(
			`[ProjectContextStore] Stale chunk sweep completed for ${documentId}`,
		);
	} catch (error) {
		// Best-effort cleanup. A failure here leaves zombie points in
		// Qdrant until the next sweep cycle, but doesn't break anything
		// else — the version-guarded DB mark still points at the correct
		// content, and retrieval-time scoring is unaffected for the new
		// version's chunks.
		logger.warn(
			`[ProjectContextStore] Failed to sweep stale document chunks for ${documentId}: ${error}`,
		);
	}
}

/**
 * Qdrant filter term that scopes a code-index delete to one repository:
 * - `undefined` -> no scoping (all of the project's repos)
 * - `null`      -> the legacy/default-repo vectors (field null or absent)
 * - a string    -> that specific repository integration's vectors
 */
function repoScopeTerms(
	repositoryIntegrationId: string | null | undefined,
): Array<Record<string, unknown>> {
	if (repositoryIntegrationId === undefined) {
		return [];
	}
	if (repositoryIntegrationId === null) {
		return [{ is_empty: { key: "repositoryIntegrationId" } }];
	}
	return [
		{
			key: "repositoryIntegrationId",
			match: { value: repositoryIntegrationId },
		},
	];
}

/**
 * Delete all code index vectors (CODE_FILE + CODE_FILE_SUMMARY) for a project.
 * Used during repo unlink cleanup to remove Phase 2 AST-aware code chunks. Pass
 * a repositoryIntegrationId to scope the delete to a single repo (per-repo
 * persistence); omit it to purge every repo (project delete).
 *
 * @param projectId - Project ID
 * @param organizationId - Organization ID (routes to correct collection)
 * @param repositoryIntegrationId - Optional: scope to one repo
 */
export async function deleteProjectCodeIndexVectors(
	projectId: string,
	organizationId?: string | null,
	repositoryIntegrationId?: string | null,
): Promise<void> {
	logger.info(
		`[ProjectContextStore] Deleting code index vectors for project: ${projectId}`,
	);

	try {
		const collectionName = await getProjectCollection(organizationId);

		await qdrantClient.delete(collectionName, {
			wait: true,
			filter: {
				must: [
					{ key: "projectId", match: { value: projectId } },
					{
						key: "contextType",
						match: { any: ["CODE_FILE", "CODE_FILE_SUMMARY"] },
					},
					...repoScopeTerms(repositoryIntegrationId),
				],
			},
		});

		logger.info(
			`[ProjectContextStore] Code index vectors deleted for project: ${projectId}`,
		);
	} catch (error) {
		logger.warn(
			`[ProjectContextStore] Failed to delete code index vectors: ${error}`,
		);
		// Don't throw — this is best-effort cleanup
	}
}

/**
 * Delete code index vectors (CODE_FILE + CODE_FILE_SUMMARY) for specific files
 * within a project. Used by incremental indexing to drop stale chunks for
 * changed/removed files before the changed ones are re-embedded — so a modified
 * file that shrank, or a deleted file, does not leave orphaned chunks behind.
 *
 * @param projectId - Project ID
 * @param organizationId - Organization ID (routes to correct collection)
 * @param filePaths - Repository-relative paths to purge
 * @param repositoryIntegrationId - Optional: scope to one repo (null = default repo)
 */
export async function deleteProjectCodeIndexVectorsForPaths(
	projectId: string,
	organizationId: string | null | undefined,
	filePaths: string[],
	repositoryIntegrationId?: string | null,
): Promise<void> {
	if (filePaths.length === 0) {
		return;
	}
	logger.info(
		`[ProjectContextStore] Deleting code index vectors for ${filePaths.length} changed file(s) in project: ${projectId}`,
	);

	try {
		const collectionName = await getProjectCollection(organizationId);

		await qdrantClient.delete(collectionName, {
			wait: true,
			filter: {
				must: [
					{ key: "projectId", match: { value: projectId } },
					{
						key: "contextType",
						match: { any: ["CODE_FILE", "CODE_FILE_SUMMARY"] },
					},
					{ key: "filePath", match: { any: filePaths } },
					...repoScopeTerms(repositoryIntegrationId),
				],
			},
		});
	} catch (error) {
		logger.warn(
			`[ProjectContextStore] Failed to delete code index vectors for paths: ${error}`,
		);
		// Surface the failure (unlike the whole-project cleanup above): this
		// path-scoped purge is the ONLY routine orphan cleanup for incremental
		// indexing — a full reindex only upserts, it never deletes — so the
		// caller should retry rather than silently leave stale chunks.
		throw error;
	}
}

/**
 * Delete all contexts for a project
 *
 * Security Model:
 * - Physical isolation: Organization data is in separate collections
 * - Access is verified at the API layer via hasProjectAccess() BEFORE calling this function
 * - Deletion uses projectId as the primary isolation key within the collection
 *
 * @param projectId - Project ID
 * @param organizationId - Organization ID (routes to correct collection + additional scoping)
 */
/**
 * Delete every Qdrant point that belongs to a URL Context Source's
 * per-page chunks.
 *
 * URL Context Sources (LINK + PATH_PREFIX) store one Qdrant point per
 * scraped page; each chunk's payload carries `parentContextId` pointing
 * at the parent `ProjectContext`. The standard `deleteProjectContext`
 * helper filters by `originalContextId` / `contextId` — for top-level
 * contexts that matches the parent contextId and cleans all chunks. For
 * URL sources the per-page chunks store the per-page id in those fields,
 * so the parent-contextId filter MISSES them and the points become
 * orphans after the Postgres cascade-delete fires.
 *
 * This helper closes that gap: a single filter-delete keyed on the
 * `parentContextId` payload field cleans every per-page chunk for the
 * given LINK context in one round-trip.
 *
 * Safe to call for non-LINK contexts — the filter just matches zero
 * points and the call is a no-op.
 */
export async function deleteUrlSourceChunks(
	parentContextId: string,
	organizationId?: string | null,
): Promise<void> {
	logger.info(
		`[ProjectContextStore] Deleting URL-source per-page chunks for parent: ${parentContextId}`,
	);

	try {
		const collectionName = await getProjectCollection(organizationId);

		// Defense-in-depth tenant scope identical to deleteAllProjectContexts.
		// Physical isolation (separate collection per org) is the primary
		// barrier; this filter is the secondary one.
		const filter: {
			must: Array<Record<string, unknown>>;
		} = {
			must: [
				{
					key: "parentContextId",
					match: { value: parentContextId },
				},
			],
		};

		if (organizationId) {
			filter.must.push({
				key: "organizationId",
				match: { value: organizationId },
			});
		} else {
			filter.must.push({
				is_null: { key: "organizationId" },
			});
		}

		await qdrantClient.delete(collectionName, { wait: true, filter });

		logger.info(
			`[ProjectContextStore] URL-source per-page chunks deleted for parent: ${parentContextId}`,
		);
	} catch (error) {
		// Mirror the rest of the deletion code: log + swallow. The parent
		// deletion path treats Qdrant cleanup as best-effort because the
		// DB rows have already been cascaded; orphan vectors are filtered
		// out at retrieval time (per `getRetrievableContextById` returning
		// null for missing rows), so a transient failure here doesn't
		// pollute AI output.
		logger.error(
			`[ProjectContextStore] Failed to delete URL-source chunks for ${parentContextId}: ${error instanceof Error ? error.message : String(error)}`,
		);
		throw error;
	}
}

export async function deleteAllProjectContexts(
	projectId: string,
	organizationId?: string,
): Promise<void> {
	logger.info(
		`[ProjectContextStore] Deleting all contexts for project: ${projectId}`,
	);

	try {
		// Get collection name (org data is in separate collection = physical isolation)
		const collectionName = await getProjectCollection(organizationId);

		// Build filter with defense-in-depth tenant isolation
		// Access control is enforced at the API layer
		const filter: any = {
			must: [
				{
					key: "projectId",
					match: { value: projectId },
				},
			],
		};

		// For org projects, scope to org (additional safety layer)
		// For personal projects, add explicit is_null check
		if (organizationId) {
			filter.must.push({
				key: "organizationId",
				match: { value: organizationId },
			});
		} else {
			// Personal context: ensure organizationId is null
			filter.must.push({
				is_null: { key: "organizationId" },
			});
		}

		// Delete from Qdrant (organization data is in separate collection)
		await qdrantClient.delete(collectionName, {
			wait: true,
			filter,
		});

		logger.info(
			`[ProjectContextStore] All contexts deleted for project: ${projectId}`,
		);
	} catch (error) {
		logger.error(
			`[ProjectContextStore] Failed to delete project contexts: ${error}`,
		);
		throw new Error(
			`Failed to delete project contexts: ${error instanceof Error ? error.message : "Unknown error"}`,
		);
	}
}
