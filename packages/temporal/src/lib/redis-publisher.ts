/**
 * Redis Publisher for Execution Events
 *
 * Singleton Redis publisher that sends real-time events from Temporal activities.
 * - Lazy connect: only establishes connection on first publish
 * - Fire-and-forget: if Redis is down, activity continues normally
 * - One shared connection across all activities in the worker
 * - Channel naming: `execution:{executionId}`
 */

import { logger } from "@repo/logs";
import { REDIS_KEEPALIVE_MS } from "@repo/utils/redis-connection";

let redisClient: import("ioredis").default | null = null;
let connectionPromise: Promise<import("ioredis").default | null> | null = null;
/** Timestamp (ms) of last connection failure; 0 means no failure recorded */
let lastFailureTime = 0;
/** Backoff before retrying after a connection failure */
const RETRY_BACKOFF_MS = 30_000; // 30 seconds

/**
 * Build a Redis URL from environment variables.
 * Prefers Aspire-injected CACHE_HOST/CACHE_PORT (dynamic port) over static
 * REDIS_URL which may reference a stale port after container restarts.
 */
function getRedisUrl(): string | null {
	// Prefer Aspire-injected vars (dynamic port assigned at container start)
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
	if (rawUrl) {
		try {
			const parsed = new URL(rawUrl);
			if (parsed.password) {
				return rawUrl;
			}
			const password =
				process.env.REDIS_PASSWORD || process.env.CACHE_PASSWORD;
			if (password) {
				parsed.password = password;
				return parsed.toString();
			}
			return rawUrl;
		} catch {
			return rawUrl;
		}
	}

	return null;
}

/**
 * Get or create the singleton Redis publisher client.
 * Returns null if Redis is unavailable.
 */
async function connectRedis(): Promise<import("ioredis").default | null> {
	const redisUrl = getRedisUrl();
	if (!redisUrl) {
		logger.debug(
			"[RedisPublisher] REDIS_URL not set, skipping Redis events",
		);
		lastFailureTime = Date.now();
		return null;
	}

	// Transport fail-closed (SOC 2 CC6.7): refuse plaintext `redis://` in
	// production — mirrors the Postgres/Temporal TLS guards. Fails closed by
	// declining to connect (events/cache degrade, loudly logged) rather than
	// silently shipping data over an unencrypted channel. Real prod uses
	// `rediss://` (TLS), so this only trips on misconfiguration; escape hatch
	// `FABRIC_ALLOW_INSECURE_REDIS=true`. Local dev (non-production) is exempt.
	if (
		process.env.NODE_ENV === "production" &&
		redisUrl.startsWith("redis://") &&
		process.env.FABRIC_ALLOW_INSECURE_REDIS !== "true"
	) {
		logger.error(
			"[RedisPublisher] Refusing plaintext redis:// connection in production (SOC 2 CC6.7). Use rediss:// (TLS), or set FABRIC_ALLOW_INSECURE_REDIS=true to override.",
		);
		lastFailureTime = Date.now();
		return null;
	}

	let client: import("ioredis").default | null = null;
	try {
		const Redis = (await import("ioredis")).default;
		client = new Redis(redisUrl, {
			maxRetriesPerRequest: 1,
			// Without this, ioredis disables TCP keepalive and an idle
			// connection is reaped upstream, surfacing as ECONNRESET on the
			// next write instead of a clean reconnect.
			keepAlive: REDIS_KEEPALIVE_MS,
			connectTimeout: 3000,
			lazyConnect: true,
			enableOfflineQueue: false,
		});

		// Attach before connect() so errors during the connection attempt are
		// handled (not logged as "[ioredis] Unhandled error event").
		// Also covers post-connect errors (drops, reconnects).
		client.on("error", (err) => {
			logger.warn("[RedisPublisher] Redis connection error", {
				error: err.message,
			});
		});

		client.on("close", () => {
			logger.debug("[RedisPublisher] Redis connection closed");
			redisClient = null;
			connectionPromise = null;
		});

		await client.connect();

		redisClient = client;
		lastFailureTime = 0;
		logger.info("[RedisPublisher] Connected to Redis");
		return client;
	} catch (err) {
		// Error already surfaced by the error event handler above
		logger.warn(
			"[RedisPublisher] Failed to connect to Redis, events will be skipped",
			{
				error: err instanceof Error ? err.message : String(err),
			},
		);
		// Disconnect so ioredis doesn't leak background reconnect timers
		try {
			client?.disconnect();
		} catch {}
		lastFailureTime = Date.now();
		connectionPromise = null;
		return null;
	}
}

async function getRedisPublisher(): Promise<import("ioredis").default | null> {
	if (redisClient) {
		return redisClient;
	}
	// If a recent failure occurred, back off before retrying
	if (
		lastFailureTime > 0 &&
		Date.now() - lastFailureTime < RETRY_BACKOFF_MS
	) {
		return null;
	}
	// Concurrent callers share the same connection promise
	if (connectionPromise) {
		return connectionPromise;
	}

	connectionPromise = connectRedis();
	return connectionPromise;
}

/**
 * Execution event payload published via Redis.
 */
export interface ExecutionEvent {
	event: string;
	data: Record<string, unknown>;
}

/**
 * Publish an execution event via Redis pub/sub.
 * Fire-and-forget: errors are logged but never thrown.
 *
 * @param executionId - The execution ID (used as channel name)
 * @param event - The event to publish
 */
export async function publishExecutionEvent(
	executionId: string,
	event: ExecutionEvent,
): Promise<void> {
	try {
		const client = await getRedisPublisher();
		if (!client) {
			logger.debug("[RedisPublisher] No client, skipping", {
				event: event.event,
			});
			return;
		}

		const channel = `execution:${executionId}`;
		const payload = JSON.stringify(event);
		const subscribers = await client.publish(channel, payload);
		logger.info("[RedisPublisher] Published", {
			channel,
			event: event.event,
			subscribers,
		});
	} catch (err) {
		logger.warn("[RedisPublisher] Publish failed", {
			event: event.event,
			error: err instanceof Error ? err.message : String(err),
		});
	}
}

/**
 * Expose the lazily-created ioredis client for shared use (e.g. redis-cache.ts).
 * Returns the singleton client if already connected, initiates a connection
 * otherwise. Returns null when Redis is unavailable or misconfigured.
 *
 * The caller must not hold a reference across worker restarts — always call
 * this function at the point of use so the lazy-reconnect logic applies.
 */
export async function getRedisClient(): Promise<
	import("ioredis").default | null
> {
	return getRedisPublisher();
}

/**
 * Gracefully disconnect the Redis publisher.
 * Called during worker shutdown.
 */
export async function disconnectRedisPublisher(): Promise<void> {
	if (redisClient) {
		try {
			await redisClient.quit();
		} catch {
			// Ignore disconnect errors
		}
		redisClient = null;
		connectionPromise = null;
	}
}
