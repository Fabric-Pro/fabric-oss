/**
 * Types for Qdrant Collection Manager
 * Handles collection-per-organization multi-tenancy
 */

/**
 * Base collection names used in the system
 */
export type BaseCollectionName =
	| "chat-documents"
	| "workspace-documents"
	| "project-contexts"
	| "fabric_orchestrator_memory"
	| "fabric_episodic_memory"
	| "fabric_capabilities";

/**
 * Payload index field schema types supported by Qdrant
 */
export type PayloadFieldSchema =
	| "keyword"
	| "integer"
	| "float"
	| "datetime"
	| "bool";

/**
 * Configuration for a payload index
 */
export interface PayloadIndexConfig {
	fieldName: string;
	fieldSchema: PayloadFieldSchema;
}

/**
 * Qdrant distance metric types
 */
export type DistanceMetric = "Cosine" | "Dot" | "Euclid" | "Manhattan";

/**
 * Configuration for a collection
 */
export interface CollectionConfig {
	baseCollection: BaseCollectionName;
	vectorSize: number;
	distanceMetric: DistanceMetric;
	payloadIndexes: PayloadIndexConfig[];
	optimizersConfig?: {
		indexingThreshold?: number;
	};
	/**
	 * When true, creates collection with named vectors:
	 * - "dense": standard embedding vector (size = vectorSize, distance = distanceMetric)
	 * - "sparse": BM25 term-frequency sparse vector for keyword matching
	 *
	 * Enables hybrid search using Qdrant's prefetch + RRF fusion.
	 * Existing collections with unnamed vectors still work — this only applies to new collections.
	 */
	enableHybrid?: boolean;
}

/**
 * Result of a migration operation
 */
export interface MigrationResult {
	organizationId: string;
	baseCollection: BaseCollectionName;
	pointsMigrated: number;
	pointsDeleted: number;
	errors: string[];
	durationMs: number;
	dryRun: boolean;
}

/**
 * Options for migration
 */
export interface MigrationOptions {
	organizationId: string;
	baseCollection: BaseCollectionName;
	batchSize?: number;
	dryRun?: boolean;
}

/**
 * Cache entry for collection existence
 */
export interface CollectionCacheEntry {
	exists: boolean;
	checkedAt: number;
}

/**
 * Runtime vector layout for a Qdrant collection.
 */
export interface CollectionLayout {
	collectionName: string;
	denseVectorName: string | null;
	sparseVectorName: string | null;
	supportsHybrid: boolean;
}
