/**
 * Capability Cache Types
 *
 * Legacy runtime capability cache implementation was removed after the
 * orchestrator standardized on the current multi-tier cache path in
 * delegation/agent-capabilities.ts (memory + Redis + DB).
 *
 * This file remains only to host the lightweight exported cache metadata
 * types referenced by the orchestrator barrel exports.
 */

/**
 * Generic cache entry metadata shape.
 */
export interface CacheEntry<T = unknown> {
	/** Cached data */
	data: T;
	/** When this entry was cached */
	cachedAt: Date;
	/** Time-to-live in milliseconds */
	ttlMs: number;
	/** Number of cache hits */
	hitCount: number;
	/** Last access time */
	lastAccessedAt: Date;
}

/**
 * Cache statistics shape.
 */
export interface CacheStats {
	/** Total entries in cache */
	totalEntries: number;
	/** Number of cache hits since creation */
	totalHits: number;
	/** Number of cache misses since creation */
	totalMisses: number;
	/** Hit rate percentage */
	hitRate: number;
	/** Memory estimate in bytes (rough) */
	estimatedMemoryBytes: number;
	/** Number of expired entries cleaned */
	entriesCleaned: number;
}
