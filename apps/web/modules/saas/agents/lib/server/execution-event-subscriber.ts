import type { ChatExecutionEvent } from "@repo/temporal";
import { REDIS_KEEPALIVE_MS } from "@repo/utils/redis-connection";
import type Redis from "ioredis";

/**
 * Build a Redis URL from environment variables.
 * Tries REDIS_URL first, then falls back to CACHE_HOST/CACHE_PORT/CACHE_PASSWORD.
 */
function getRedisUrl(): string | null {
	// Prefer Aspire-injected CACHE_HOST/CACHE_PORT (dynamic port) over
	// static REDIS_URL which may point at a stale port.
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
 * Subscribe to a workflow's live events (`execution:<executionId>`: text
 * deltas, tool calls, limit signals) and hand each parsed event over until
 * the returned function unsubscribes. Redis pub/sub does not buffer, so call
 * this BEFORE starting the workflow. Without Redis (no URL, or the connection
 * fails) nothing is delivered and the text appears on completion.
 */
export async function subscribeExecutionEvents({
	executionId,
	onEvent,
	logPrefix,
}: {
	executionId: string;
	onEvent: (event: ChatExecutionEvent) => void;
	logPrefix: string;
}): Promise<() => void> {
	const redisUrl = getRedisUrl();
	if (!redisUrl) {
		return () => {};
	}
	let redisSubscriber: Redis | null = null;
	const cleanup = () => {
		if (redisSubscriber) {
			try {
				redisSubscriber.unsubscribe();
				redisSubscriber.quit();
			} catch {
				// Ignore cleanup errors
			}
			redisSubscriber = null;
		}
	};
	try {
		const RedisClient = (await import("ioredis")).default;
		const subscriber = new RedisClient(redisUrl, {
			maxRetriesPerRequest: 1,
			// Without this, ioredis disables TCP keepalive and an idle
			// connection is reaped upstream, surfacing as ECONNRESET on the
			// next write instead of a clean reconnect.
			keepAlive: REDIS_KEEPALIVE_MS,
			connectTimeout: 3000,
			lazyConnect: true,
			enableOfflineQueue: false,
		});
		redisSubscriber = subscriber;

		// Attach the error listener BEFORE connect(). ioredis emits `error`
		// during the connection attempt itself, and an `error` event with no
		// listener is re-raised by Node as "[ioredis] Unhandled error event"
		// at process level — 642 of them in production between 2026-06-17
		// and 2026-08-07, all charged to the Orchestrator stream route. The
		// publisher in `@repo/temporal` already orders it this way; the route
		// registered the listener after connect() and so had no listener
		// during the only window that reliably throws.
		subscriber.on("error", (err: Error) => {
			console.warn(`${logPrefix} Redis subscriber error:`, err.message);
			if (redisSubscriber) {
				redisSubscriber.disconnect();
				redisSubscriber = null;
			}
		});

		await subscriber.connect();

		// Attach handlers BEFORE subscribing to avoid missing messages
		// between subscribe acknowledgement and handler registration
		subscriber.on("message", (_ch: string, message: string) => {
			if (!redisSubscriber) {
				return;
			}
			try {
				const event: ChatExecutionEvent = JSON.parse(message);
				onEvent(event);
			} catch {
				// Invalid message, skip
			}
		});

		const channel = `execution:${executionId}`;
		await subscriber.subscribe(channel);

		console.log(`${logPrefix} Redis subscriber connected`, { channel });
	} catch (err) {
		console.warn(
			`${logPrefix} Redis unavailable, text will appear on completion:`,
			err instanceof Error ? err.message : String(err),
		);
		// Disconnect before dropping the reference. Nulling alone leaks the
		// instance and its background reconnect timers for the life of the
		// (reused) function instance, which is what turned one bad URL into
		// a repeating error stream. The error listener above may already
		// have done both.
		const failed: Redis | null = redisSubscriber;
		if (failed) {
			try {
				failed.disconnect();
			} catch {
				// already torn down
			}
			redisSubscriber = null;
		}
	}
	return cleanup;
}
