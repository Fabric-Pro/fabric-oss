/**
 * Redis Cache — Typed key/value cache layer
 *
 * Thin wrapper around the shared ioredis client from redis-publisher.ts.
 * Designed to be used as a fast L1 cache in front of heavier L2 sources
 * (database reads, embedding API calls, HTTP fetches).
 *
 * Safety contract:
 * - All operations catch errors internally and NEVER throw to callers.
 * - If Redis is unavailable the helpers are silent no-ops.
 * - The underlying client connection is shared with RedisPublisher —
 *   no second TCP connection is opened.
 */

import { createHash } from "node:crypto";
import { logger } from "@repo/logs";
import { getRedisClient } from "./redis-publisher";

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Produce a short deterministic hex digest of a string.
 * Used to turn arbitrary query text into a safe Redis key segment.
 */
function shortHash(text: string): string {
	return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

// ---------------------------------------------------------------------------
// Key builders — single source of truth for cache key format
// ---------------------------------------------------------------------------

export const CacheKeys = {
	/**
	 * Key for a query embedding vector.
	 * Scoped to userId + organizationId so org-specific embedding models
	 * don't return a stale personal-context vector for the same query.
	 */
	queryEmbedding: (
		queryText: string,
		userId: string,
		organizationId?: string | null,
	): string =>
		`embed:query:${userId}:${organizationId ?? "personal"}:${shortHash(queryText)}`,

	/**
	 * Key for a pre-computed agent description embedding.
	 * Scoped to the embedding model so different models don't share vectors.
	 */
	agentEmbedding: (agentId: string, embeddingModel?: string): string =>
		embeddingModel
			? `embed:agent:${agentId}:${shortHash(embeddingModel)}`
			: `embed:agent:${agentId}`,

	/**
	 * Key for an agent card JSON document.
	 */
	agentCard: (agentId: string): string => `agentcard:${agentId}`,

	/**
	 * Key for a fetched meeting transcript. Scoped to the user (the calendar is
	 * the signed-in user's) AND the specific instance (joinUrl + the selected
	 * startTime), so recurring-meeting instances never collide. A finalized
	 * transcript is immutable, so this is safe to cache for a long TTL.
	 */
	meetingTranscript: (
		userId: string,
		joinUrl: string,
		startTime?: string,
	): string =>
		`transcript:${userId}:${shortHash(joinUrl)}:${startTime ?? "latest"}`,
};

// ---------------------------------------------------------------------------
// TTLs (seconds)
// ---------------------------------------------------------------------------

export const CacheTTL = {
	/** 10 minutes — query embeddings are short-lived; queries may change */
	queryEmbedding: 600,
	/** 30 minutes — agent embeddings are stable within a deploy cycle */
	agentEmbedding: 1800,
	/** 5 minutes — mirrors DB_CACHE_TTL_MS in agent-capabilities.ts */
	agentCard: 300,
	/** 7 days — a finalized meeting transcript never changes */
	meetingTranscript: 7 * 24 * 60 * 60,
} as const;

// ---------------------------------------------------------------------------
// Public cache API
// ---------------------------------------------------------------------------

export const RedisCache = {
	/**
	 * Store a JSON-serialisable value with a TTL.
	 * Fire-and-forget safe — errors are logged, never thrown.
	 */
	async set(key: string, value: unknown, ttlSeconds: number): Promise<void> {
		try {
			const client = await getRedisClient();
			if (!client) {
				return;
			}
			const serialized = JSON.stringify(value);
			await client.set(key, serialized, "EX", ttlSeconds);
		} catch (err) {
			logger.warn("[RedisCache] set error", {
				key,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	},

	/**
	 * Retrieve and deserialise a cached value.
	 * Returns null on cache miss, Redis unavailability, or parse error.
	 */
	async get<T>(key: string): Promise<T | null> {
		try {
			const client = await getRedisClient();
			if (!client) {
				return null;
			}
			const raw = await client.get(key);
			if (raw === null) {
				return null;
			}
			return JSON.parse(raw) as T;
		} catch (err) {
			logger.warn("[RedisCache] get error", {
				key,
				error: err instanceof Error ? err.message : String(err),
			});
			return null;
		}
	},

	/**
	 * Delete a key.
	 * Fire-and-forget safe — errors are logged, never thrown.
	 */
	async del(key: string): Promise<void> {
		try {
			const client = await getRedisClient();
			if (!client) {
				return;
			}
			await client.del(key);
		} catch (err) {
			logger.warn("[RedisCache] del error", {
				key,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	},
};
