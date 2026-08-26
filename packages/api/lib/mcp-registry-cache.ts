/**
 * Redis cache for MCP registry system servers.
 *
 * System servers are seeded data that rarely change at runtime. Caching them
 * avoids a multi-row DB query on every registry dialog open.
 *
 * Invalidation strategy — DB-driven content versioning:
 *
 *   The Postgres trigger installed in migration
 *   20260523000200_add_mcp_registry_version_tracking bumps a
 *   `mcp_registry_version` counter on every INSERT/UPDATE/DELETE against
 *   `mcp_server`. The cache key embeds that counter
 *   (`mcp:registry:system-servers:v<N>`), so any write — Prisma, raw SQL
 *   migration, or hand-edit — produces a brand-new key on the very next
 *   request. The previous-version key is orphaned and expires via TTL.
 *
 *   Net effect: zero application-side discipline is required to keep the
 *   cache fresh after a config change. The first read after a write is a
 *   guaranteed cache miss; the response includes the freshly-written rows.
 *
 * TTL is intentionally short (1 hour) because the version-stamping handles
 * the freshness case automatically; the TTL is now only a safety net for
 * orphaned old-version keys, which would otherwise linger indefinitely.
 */

import { getMcpRegistryVersion } from "@repo/database";
import { logger } from "@repo/logs";
import { REDIS_KEEPALIVE_MS } from "@repo/utils/redis-connection";

const CACHE_KEY_PREFIX = "mcp:registry:system-servers";
const CACHE_KEY_LEGACY_FALLBACK = `${CACHE_KEY_PREFIX}:legacy`;
const CACHE_TTL_SECONDS = 60 * 60; // 1 hour — safety net for orphaned versioned keys

// We deliberately do NOT memoize the version read in-process. The DB-side
// counter sits in a single-row table behind a PK lookup, so the round-trip
// is sub-millisecond; memoizing for even a few seconds would re-introduce a
// staleness window after a write and weaken AC1's instant-invalidation
// guarantee — the very bug this whole change set is here to fix.

function getRedisUrl(): string | null {
	const cacheHost = process.env.CACHE_HOST;
	if (cacheHost) {
		const cachePort = process.env.CACHE_PORT || "6379";
		const password =
			process.env.CACHE_PASSWORD || process.env.REDIS_PASSWORD;
		if (password) {
			return `redis://:${encodeURIComponent(password)}@${cacheHost}:${cachePort}`;
		}
		return `redis://${cacheHost}:${cachePort}`;
	}
	const rawUrl = process.env.REDIS_URL;
	return rawUrl || null;
}

async function getRedis(): Promise<import("ioredis").default | null> {
	const url = getRedisUrl();
	if (!url) {
		return null;
	}
	let client: import("ioredis").default | null = null;
	try {
		const Redis = (await import("ioredis")).default;
		client = new Redis(url, {
			maxRetriesPerRequest: 1,
			// Without this, ioredis disables TCP keepalive and an idle
			// connection is reaped upstream, surfacing as ECONNRESET on the
			// next write instead of a clean reconnect.
			keepAlive: REDIS_KEEPALIVE_MS,
			connectTimeout: 2000,
			lazyConnect: true,
			enableOfflineQueue: false,
		});
		// Attach before connect() so the error event is handled (not "unhandled")
		client.on("error", () => {});
		await client.connect();
		return client;
	} catch {
		// Disconnect so ioredis doesn't leak background reconnect timers
		try {
			client?.disconnect();
		} catch {}
		return null;
	}
}

/**
 * Resolve the current cache key for the registry. Reads the DB-side version
 * counter so writes naturally invalidate the cache on the next request.
 *
 * Falls back to a static `:legacy` key when the version table doesn't exist
 * (pre-migration deployments) so the rest of the cache pipeline keeps
 * working — only auto-invalidation is degraded.
 */
async function resolveCacheKey(): Promise<{
	key: string;
	version: bigint | null;
}> {
	const version = await getMcpRegistryVersion();
	if (version === null) {
		return { key: CACHE_KEY_LEGACY_FALLBACK, version: null };
	}
	return { key: `${CACHE_KEY_PREFIX}:v${version.toString()}`, version };
}

export async function getCachedSystemServers<T>(): Promise<T[] | null> {
	const { key, version } = await resolveCacheKey();
	const redis = await getRedis();
	if (!redis) {
		logger.debug(
			{ event: "mcp.cache.skipped", reason: "redis-unavailable", key },
			"[mcp-registry-cache] Redis not configured; serving from DB",
		);
		return null;
	}
	try {
		const raw = await redis.get(key);
		await redis.quit();
		if (!raw) {
			logger.info(
				{
					event: "mcp.cache.miss",
					key,
					version: version === null ? "legacy" : version.toString(),
				},
				"[mcp-registry-cache] cache miss",
			);
			return null;
		}
		logger.debug(
			{
				event: "mcp.cache.hit",
				key,
				version: version === null ? "legacy" : version.toString(),
			},
			"[mcp-registry-cache] cache hit",
		);
		return JSON.parse(raw) as T[];
	} catch (error) {
		logger.warn(
			{ event: "mcp.cache.error", op: "get", key, err: error },
			"[mcp-registry-cache] Redis GET failed; falling back to DB",
		);
		try {
			await redis.quit();
		} catch {}
		return null;
	}
}

export async function setCachedSystemServers<T>(servers: T[]): Promise<void> {
	const { key, version } = await resolveCacheKey();
	const redis = await getRedis();
	if (!redis) {
		return;
	}
	try {
		await redis.set(key, JSON.stringify(servers), "EX", CACHE_TTL_SECONDS);
		logger.debug(
			{
				event: "mcp.cache.write",
				key,
				version: version === null ? "legacy" : version.toString(),
				count: servers.length,
				ttlSeconds: CACHE_TTL_SECONDS,
			},
			"[mcp-registry-cache] cache populated",
		);
	} catch (error) {
		logger.warn(
			{ event: "mcp.cache.error", op: "set", key, err: error },
			"[mcp-registry-cache] Redis SET failed (non-fatal)",
		);
	} finally {
		try {
			await redis.quit();
		} catch {}
	}
}

/**
 * Force-invalidate every cached system-server list.
 *
 * With DB-driven version stamping the cache normally rotates itself, so
 * callers should reach for this only when they've mutated state that the
 * trigger can't observe (e.g. side-channel reauth that doesn't touch
 * `mcp_server` but should still feel "fresh" to the user — see the GitLab
 * OAuth disconnect path). Wipes every key in the
 * `mcp:registry:system-servers:*` family using non-blocking SCAN.
 */
export async function invalidateSystemServersCache(): Promise<void> {
	const redis = await getRedis();
	if (!redis) {
		return;
	}
	try {
		let cursor = "0";
		let deleted = 0;
		const matchPattern = `${CACHE_KEY_PREFIX}:*`;
		do {
			const [next, batch] = await redis.scan(
				cursor,
				"MATCH",
				matchPattern,
				"COUNT",
				100,
			);
			cursor = next;
			if (batch.length > 0) {
				deleted += await redis.del(...batch);
			}
		} while (cursor !== "0");
		logger.info(
			{ event: "mcp.cache.invalidate", deleted, pattern: matchPattern },
			"[mcp-registry-cache] cache invalidated",
		);
	} catch (error) {
		logger.warn(
			{ event: "mcp.cache.error", op: "invalidate", err: error },
			"[mcp-registry-cache] invalidate failed (non-fatal)",
		);
	} finally {
		try {
			await redis.quit();
		} catch {}
	}
}
