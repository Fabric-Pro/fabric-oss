/**
 * Qdrant Collection Manager
 *
 * Implements collection-per-organization multi-tenancy for complete
 * physical isolation between organization data.
 *
 * Architecture:
 * - Personal data (organizationId = null): Shared collections with userId filtering
 * - Organization data: Dedicated collections named {base}-org-{orgId}
 */

import { logger } from "@repo/logs";
import {
	DISTANCE_METRIC,
	qdrantClient,
	VECTOR_SIZE,
} from "../vector-store/client";
import type {
	BaseCollectionName,
	CollectionCacheEntry,
	CollectionConfig,
	CollectionLayout,
	DistanceMetric,
} from "./types";

// Re-export types
export * from "./types";

// Cache TTL for collection existence checks (5 minutes)
const CACHE_TTL_MS = 5 * 60 * 1000;

// In-memory cache for collection existence
const collectionExistsCache = new Map<string, CollectionCacheEntry>();

// Track collections being created to prevent race conditions
const collectionsBeingCreated = new Map<string, Promise<void>>();
const collectionLayoutCache = new Map<string, CollectionLayout>();

// Default distance metric cast to proper type
const DEFAULT_DISTANCE_METRIC: DistanceMetric =
	DISTANCE_METRIC as DistanceMetric;

/**
 * Collection configurations for each base collection type
 */
const COLLECTION_CONFIGS: Record<
	BaseCollectionName,
	Omit<CollectionConfig, "baseCollection">
> = {
	"chat-documents": {
		vectorSize: VECTOR_SIZE,
		distanceMetric: DEFAULT_DISTANCE_METRIC,
		enableHybrid: true,
		payloadIndexes: [
			{ fieldName: "chatId", fieldSchema: "keyword" },
			{ fieldName: "userId", fieldSchema: "keyword" },
			{ fieldName: "organizationId", fieldSchema: "keyword" },
			{ fieldName: "documentId", fieldSchema: "keyword" },
		],
		optimizersConfig: { indexingThreshold: 10000 },
	},
	"workspace-documents": {
		vectorSize: VECTOR_SIZE,
		distanceMetric: DEFAULT_DISTANCE_METRIC,
		enableHybrid: true,
		payloadIndexes: [
			{ fieldName: "workspaceId", fieldSchema: "keyword" },
			{ fieldName: "documentId", fieldSchema: "keyword" },
			{ fieldName: "userId", fieldSchema: "keyword" },
			{ fieldName: "organizationId", fieldSchema: "keyword" },
			{ fieldName: "chunkId", fieldSchema: "keyword" },
		],
		optimizersConfig: { indexingThreshold: 10000 },
	},
	"project-contexts": {
		vectorSize: VECTOR_SIZE,
		distanceMetric: DEFAULT_DISTANCE_METRIC,
		enableHybrid: true,
		payloadIndexes: [
			{ fieldName: "projectId", fieldSchema: "keyword" },
			{ fieldName: "userId", fieldSchema: "keyword" },
			{ fieldName: "organizationId", fieldSchema: "keyword" },
			{ fieldName: "contextId", fieldSchema: "keyword" },
			// Required for filter-based deletion of chunked contexts — every
			// stored chunk carries originalContextId pointing back to the base
			// context, and deleteProjectContext filters on it. Without the
			// index Qdrant returns 400 Bad Request on the delete filter.
			{ fieldName: "originalContextId", fieldSchema: "keyword" },
			// Integer range filter used by the zombie-sweep workflow to
			// find and delete chunks whose documentVersion has fallen
			// behind the source ProjectDocument's current version (i.e.
			// stragglers from a superseded embed run).
			{ fieldName: "documentVersion", fieldSchema: "integer" },
			{ fieldName: "sessionId", fieldSchema: "keyword" }, // For wizard context isolation
			{ fieldName: "isWizardContext", fieldSchema: "bool" }, // To distinguish wizard from project contexts
			// Code indexing payload indexes (Phase 2)
			{ fieldName: "contextType", fieldSchema: "keyword" }, // CODE_FILE, CODE_FILE_SUMMARY, etc.
			{ fieldName: "filePath", fieldSchema: "keyword" }, // Filter by file path
			{ fieldName: "language", fieldSchema: "keyword" }, // Filter by programming language
			{ fieldName: "symbolName", fieldSchema: "keyword" }, // Filter by function/class name
			{ fieldName: "symbolType", fieldSchema: "keyword" }, // Filter by symbol type (function, class, etc.)
		],
		optimizersConfig: { indexingThreshold: 10000 },
	},
	fabric_orchestrator_memory: {
		vectorSize: VECTOR_SIZE,
		distanceMetric: DEFAULT_DISTANCE_METRIC,
		payloadIndexes: [
			{ fieldName: "userId", fieldSchema: "keyword" },
			{ fieldName: "organizationId", fieldSchema: "keyword" },
			{ fieldName: "outcome", fieldSchema: "keyword" },
			{ fieldName: "timestamp", fieldSchema: "datetime" },
		],
		optimizersConfig: { indexingThreshold: 10000 },
	},
	fabric_episodic_memory: {
		vectorSize: VECTOR_SIZE,
		distanceMetric: DEFAULT_DISTANCE_METRIC,
		payloadIndexes: [
			{ fieldName: "userId", fieldSchema: "keyword" },
			{ fieldName: "organizationId", fieldSchema: "keyword" },
			{ fieldName: "projectId", fieldSchema: "keyword" },
			{ fieldName: "workspaceId", fieldSchema: "keyword" },
			{ fieldName: "agentId", fieldSchema: "keyword" },
			{ fieldName: "conversationId", fieldSchema: "keyword" },
			{ fieldName: "outcome", fieldSchema: "keyword" },
			{ fieldName: "conversationEndedAt", fieldSchema: "datetime" },
		],
		optimizersConfig: { indexingThreshold: 10000 },
	},
	fabric_capabilities: {
		vectorSize: VECTOR_SIZE,
		distanceMetric: DEFAULT_DISTANCE_METRIC,
		payloadIndexes: [
			{ fieldName: "userId", fieldSchema: "keyword" },
			{ fieldName: "organizationId", fieldSchema: "keyword" },
			{ fieldName: "type", fieldSchema: "keyword" },
			{ fieldName: "metadata.category", fieldSchema: "keyword" },
			{ fieldName: "metadata.serverName", fieldSchema: "keyword" },
		],
		optimizersConfig: { indexingThreshold: 10000 },
	},
};

/**
 * Validate organization ID to prevent collection name injection
 */
function validateOrganizationId(orgId: string): boolean {
	// Only allow alphanumeric, underscores, and hyphens
	return /^[a-zA-Z0-9_-]+$/.test(orgId);
}

/**
 * Get the collection name for a given base collection and optional organization
 *
 * @param baseCollection - The base collection name
 * @param organizationId - Optional organization ID for org-specific collections
 * @returns The resolved collection name
 */
export function getCollectionName(
	baseCollection: BaseCollectionName,
	organizationId?: string | null,
): string {
	if (!organizationId) {
		// Personal data uses shared collection
		return baseCollection;
	}

	if (!validateOrganizationId(organizationId)) {
		throw new Error(`Invalid organization ID format: ${organizationId}`);
	}

	// Organization data uses dedicated collection
	return `${baseCollection}-org-${organizationId}`;
}

/**
 * Base name of the collection holding project-context vectors.
 *
 * The name on the wire is tenant-dependent and MUST be resolved through
 * `getCollectionName`: personal data lives in this shared collection, an
 * organization's in `project-contexts-org-<orgId>`. Every writer resolves it
 * the same way, so a hardcoded literal that does not match turns a delete into
 * a no-op that leaves every vector behind, and turns a clear-then-re-embed
 * into a pile-up of stale points under the new ones. Exported so the delete
 * and reprocess paths that resolve it cannot drift from the writers.
 */
export const PROJECT_CONTEXTS_BASE_COLLECTION = "project-contexts" as const;

/**
 * Whether the resolved collection exists in Qdrant RIGHT NOW.
 *
 * Deliberately UNCACHED, and deliberately separate from the private
 * `checkCollectionExists` below, which memoizes for five minutes. The callers
 * of this function are delete and clear paths that treat "no such collection"
 * as success — a tenant that never embedded anything legitimately has none —
 * so a stale `false` would skip a real delete and report it as done, leaving
 * vectors searchable that the caller has just told the user are gone. That is
 * precisely the failure these call sites exist to distinguish, so they must
 * ask Qdrant every time.
 *
 * Deliberately a plain existence check and NOT `ensureCollection`, which
 * *creates* the collection it resolves — that would make "this tenant never
 * embedded anything" permanently indistinguishable from "the delete failed",
 * and would have a cleanup path conjuring collections into existence as a side
 * effect. Mirrors the check `deleteOrganizationCollections` performs before
 * dropping a collection.
 *
 * A Qdrant failure PROPAGATES rather than degrading to `false`, so an
 * unreachable vector store cannot masquerade as an empty one.
 */
export async function collectionExistsUncached(
	collectionName: string,
): Promise<boolean> {
	const { collections } = await qdrantClient.getCollections();
	return collections.some((collection) => collection.name === collectionName);
}

/**
 * Check if a collection exists (with caching)
 */
async function checkCollectionExists(collectionName: string): Promise<boolean> {
	// Check cache first
	const cached = collectionExistsCache.get(collectionName);
	if (cached && Date.now() - cached.checkedAt < CACHE_TTL_MS) {
		return cached.exists;
	}

	try {
		const collections = await qdrantClient.getCollections();
		const exists = collections.collections.some(
			(col) => col.name === collectionName,
		);

		// Update cache
		collectionExistsCache.set(collectionName, {
			exists,
			checkedAt: Date.now(),
		});

		return exists;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		// 403 Forbidden means the API key is missing or lacks permissions.
		// Re-throw immediately — treating it as "collection doesn't exist" would
		// trigger a createCollection call that also fails, masking the root cause.
		if (
			message.includes("Forbidden") ||
			message.includes("403") ||
			message.includes("Unauthorized") ||
			message.includes("401")
		) {
			throw new Error(
				`Qdrant authentication failed — check QDRANT_API_KEY is set and has manage permissions: ${message}`,
			);
		}
		logger.error(
			`[CollectionManager] Failed to check collection existence: ${error}`,
		);
		// Don't cache errors
		return false;
	}
}

/**
 * Create a collection with the specified configuration
 */
async function createCollection(
	collectionName: string,
	config: Omit<CollectionConfig, "baseCollection">,
): Promise<void> {
	logger.info(`[CollectionManager] Creating collection: ${collectionName}`);

	try {
		// Build vectors config — hybrid mode uses named vectors (dense + sparse)
		const collectionParams: any = {
			optimizers_config: config.optimizersConfig
				? {
						indexing_threshold:
							config.optimizersConfig.indexingThreshold,
					}
				: undefined,
		};

		if (config.enableHybrid) {
			// Named vectors: "dense" for embeddings, "sparse" for BM25 keywords
			collectionParams.vectors = {
				dense: {
					size: config.vectorSize,
					distance: config.distanceMetric,
				},
			};
			collectionParams.sparse_vectors = {
				sparse: {},
			};

			logger.info(
				`[CollectionManager] Creating hybrid collection with dense + sparse vectors: ${collectionName}`,
			);
		} else {
			// Single unnamed vector (backward compatible)
			collectionParams.vectors = {
				size: config.vectorSize,
				distance: config.distanceMetric,
			};
		}

		await qdrantClient.createCollection(collectionName, collectionParams);

		logger.info(
			`[CollectionManager] Collection created: ${collectionName}`,
		);

		// Create payload indexes
		for (const index of config.payloadIndexes) {
			try {
				await qdrantClient.createPayloadIndex(collectionName, {
					field_name: index.fieldName,
					field_schema: index.fieldSchema,
				});
				logger.debug(
					`[CollectionManager] Created index ${index.fieldName} on ${collectionName}`,
				);
			} catch (indexError) {
				logger.warn(
					`[CollectionManager] Failed to create index ${index.fieldName} on ${collectionName}: ${indexError}`,
				);
				// Continue with other indexes
			}
		}

		// Update cache
		collectionExistsCache.set(collectionName, {
			exists: true,
			checkedAt: Date.now(),
		});

		logger.info(
			`[CollectionManager] Collection ${collectionName} fully initialized`,
		);

		collectionLayoutCache.delete(collectionName);
	} catch (error) {
		logger.error(
			`[CollectionManager] Failed to create collection ${collectionName}: ${error}`,
		);
		throw new Error(
			`Failed to create collection ${collectionName}: ${error instanceof Error ? error.message : "Unknown error"}`,
		);
	}
}

function getDenseVectorName(vectorsConfig: unknown): string | null {
	if (!vectorsConfig || typeof vectorsConfig !== "object") {
		return null;
	}

	if ("size" in (vectorsConfig as Record<string, unknown>)) {
		return null;
	}

	if ("dense" in (vectorsConfig as Record<string, unknown>)) {
		return "dense";
	}

	const vectorNames = Object.keys(vectorsConfig as Record<string, unknown>);
	return vectorNames[0] ?? null;
}

async function ensureHybridCompatibility(
	collectionName: string,
	config: Omit<CollectionConfig, "baseCollection">,
): Promise<CollectionLayout> {
	const cached = collectionLayoutCache.get(collectionName);
	if (cached) {
		return cached;
	}

	const info = await qdrantClient.getCollection(collectionName);
	const params = (info?.config?.params ?? {}) as Record<string, unknown>;
	const denseVectorName = getDenseVectorName(params.vectors);
	const sparseVectors = params.sparse_vectors;
	let supportsHybrid =
		!!sparseVectors &&
		typeof sparseVectors === "object" &&
		Object.keys(sparseVectors as Record<string, unknown>).length > 0;

	if (config.enableHybrid && !supportsHybrid) {
		try {
			await qdrantClient.updateCollection(collectionName, {
				sparse_vectors: {
					sparse: {},
				},
			});
			supportsHybrid = true;
			logger.info(
				`[CollectionManager] Enabled sparse vectors for existing collection: ${collectionName}`,
			);
		} catch (error) {
			logger.warn(
				`[CollectionManager] Failed to enable sparse vectors for ${collectionName}: ${error}`,
			);
		}
	}

	// Backfill payload indexes on existing collections. New fields added to
	// COLLECTION_CONFIGS (e.g. originalContextId) won't exist on collections
	// created before the change, and Qdrant rejects delete-by-filter on
	// unindexed fields with 400 Bad Request.
	const indexesFullyBackfilled = await ensurePayloadIndexes(
		collectionName,
		info,
		config,
	);

	const layout: CollectionLayout = {
		collectionName,
		denseVectorName,
		sparseVectorName: supportsHybrid ? "sparse" : null,
		supportsHybrid,
	};
	// Only cache the layout once every required payload index is known to
	// exist. If a transient Qdrant error (e.g. 503, missing manage perm)
	// caused a backfill to fail, leave the cache empty so the next call
	// retries instead of locking in a broken state where deleteProjectContext
	// would keep returning 400 Bad Request until the worker restarts.
	if (indexesFullyBackfilled) {
		collectionLayoutCache.set(collectionName, layout);
	}
	return layout;
}

/**
 * Ensure all payload indexes in `config` exist on the collection. Missing
 * indexes are created; existing ones are skipped. Returns `true` iff every
 * required index is confirmed present at the end of the call.
 *
 * A persistent failure here leaves the caller free to skip caching so that
 * the backfill is retried on the next access — important because Qdrant
 * rejects delete-by-filter on unindexed fields with 400 Bad Request, and a
 * sticky failed-success cache would silently break re-embed flows for the
 * whole worker lifetime.
 */
async function ensurePayloadIndexes(
	collectionName: string,
	collectionInfo: unknown,
	config: Omit<CollectionConfig, "baseCollection">,
): Promise<boolean> {
	const existingIndexes = new Set<string>();
	const payloadSchema = (
		collectionInfo as { payload_schema?: Record<string, unknown> } | null
	)?.payload_schema;
	if (payloadSchema && typeof payloadSchema === "object") {
		for (const fieldName of Object.keys(payloadSchema)) {
			existingIndexes.add(fieldName);
		}
	}

	let allSucceeded = true;
	for (const index of config.payloadIndexes) {
		if (existingIndexes.has(index.fieldName)) {
			continue;
		}
		try {
			await qdrantClient.createPayloadIndex(collectionName, {
				field_name: index.fieldName,
				field_schema: index.fieldSchema,
			});
			logger.info(
				`[CollectionManager] Backfilled payload index ${index.fieldName} on ${collectionName}`,
			);
		} catch (indexError) {
			logger.warn(
				`[CollectionManager] Failed to backfill payload index ${index.fieldName} on ${collectionName}: ${indexError}`,
			);
			allSucceeded = false;
		}
	}
	return allSucceeded;
}

/**
 * Ensure a collection exists, creating it if necessary
 *
 * @param baseCollection - The base collection name
 * @param organizationId - Optional organization ID for org-specific collections
 * @returns The collection name (created if necessary)
 */
export async function ensureCollection(
	baseCollection: BaseCollectionName,
	organizationId?: string | null,
): Promise<string> {
	const collectionName = getCollectionName(baseCollection, organizationId);
	const config = COLLECTION_CONFIGS[baseCollection];

	// Check if collection exists
	const exists = await checkCollectionExists(collectionName);
	if (exists) {
		await ensureHybridCompatibility(collectionName, config);
		return collectionName;
	}

	// Check if collection is already being created (prevent race conditions)
	const existingCreation = collectionsBeingCreated.get(collectionName);
	if (existingCreation) {
		await existingCreation;
		return collectionName;
	}

	// Create the collection
	const creationPromise = createCollection(collectionName, config);
	collectionsBeingCreated.set(collectionName, creationPromise);

	try {
		await creationPromise;
	} finally {
		collectionsBeingCreated.delete(collectionName);
	}

	return collectionName;
}

export async function getCollectionLayout(
	baseCollection: BaseCollectionName,
	organizationId?: string | null,
): Promise<CollectionLayout> {
	const collectionName = await ensureCollection(
		baseCollection,
		organizationId,
	);
	return ensureHybridCompatibility(
		collectionName,
		COLLECTION_CONFIGS[baseCollection],
	);
}

/**
 * Delete all collections for an organization
 * Called when an organization is deleted
 *
 * @param organizationId - The organization ID
 */
export async function deleteOrganizationCollections(
	organizationId: string,
): Promise<void> {
	if (!validateOrganizationId(organizationId)) {
		throw new Error(`Invalid organization ID format: ${organizationId}`);
	}

	const baseCollections: BaseCollectionName[] = [
		"chat-documents",
		"workspace-documents",
		"project-contexts",
		"fabric_orchestrator_memory",
		"fabric_capabilities",
	];

	logger.info(
		`[CollectionManager] Deleting all collections for organization: ${organizationId}`,
	);

	for (const baseCollection of baseCollections) {
		const collectionName = getCollectionName(
			baseCollection,
			organizationId,
		);

		try {
			const exists = await checkCollectionExists(collectionName);
			if (exists) {
				await qdrantClient.deleteCollection(collectionName);
				logger.info(
					`[CollectionManager] Deleted collection: ${collectionName}`,
				);

				// Invalidate cache
				collectionExistsCache.delete(collectionName);
			}
		} catch (error) {
			logger.error(
				`[CollectionManager] Failed to delete collection ${collectionName}: ${error}`,
			);
			// Continue with other collections, don't fail entire operation
		}
	}

	logger.info(
		`[CollectionManager] Completed deletion for organization: ${organizationId}`,
	);
}

/**
 * Invalidate the cache for a specific collection
 */
export function invalidateCollectionCache(collectionName: string): void {
	collectionExistsCache.delete(collectionName);
}

/**
 * Clear the entire collection existence cache
 */
export function clearCollectionCache(): void {
	collectionExistsCache.clear();
}

/**
 * Get cache statistics (for debugging/monitoring)
 */
export function getCacheStats(): { size: number; entries: string[] } {
	return {
		size: collectionExistsCache.size,
		entries: Array.from(collectionExistsCache.keys()),
	};
}
