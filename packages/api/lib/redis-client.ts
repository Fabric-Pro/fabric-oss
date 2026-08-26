/**
 * Shared Upstash Redis client singleton.
 * Lazily initialises a single `Redis` instance from environment variables
 * (`UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN`) and caches the
 * result. Returns `null` whenever the credentials are missing or the
 * client cannot be constructed — callers are expected to treat `null` as
 * "Redis miss → fall back to the slower path" (Postgres, in-memory store,
 * etc.). Production callers that require Redis must check for `null` and
 * fail closed themselves; this module deliberately does not throw so it
 * is safe to import from build/SSR contexts where the env may be unset.
 * Both the rate-limiter (`rate-limit.ts`) and the AI usage-limits
 * subsystem (`@repo/payments`) read from this single client to avoid
 * duplicating connection state and to share Upstash's connection pool.
 */

import { validateRateLimitBootEnv } from "@repo/auth/lib/boot-validate";
import { Redis } from "@upstash/redis";

// Boot-time validation: in production this throws if Upstash creds are
// absent, matching the original behaviour from rate-limit.ts.
validateRateLimitBootEnv();

let redisClient: Redis | null = null;
let redisAvailable: boolean | null = null;

/**
 * Return the shared Redis client, or `null` when Upstash is not
 * configured / failed to initialise.
 * The result is cached after the first call; subsequent calls are
 * effectively free.
 */
export function getRedisClient(): Redis | null {
	if (redisAvailable === false) {
		return null;
	}

	if (redisClient) {
		return redisClient;
	}

	const url = process.env.UPSTASH_REDIS_REST_URL;
	const token = process.env.UPSTASH_REDIS_REST_TOKEN;

	if (!url || !token) {
		redisAvailable = false;
		if (process.env.NODE_ENV === "development") {
			console.log(
				"[RedisClient] Upstash not configured, falling back to in-memory / Postgres-only paths",
			);
		}
		return null;
	}

	try {
		redisClient = new Redis({ url, token });
		redisAvailable = true;
		if (process.env.NODE_ENV === "development") {
			console.log("[RedisClient] Connected to Upstash Redis");
		}
		return redisClient;
	} catch (error) {
		console.error("[RedisClient] Failed to initialise Upstash:", error);
		redisAvailable = false;
		return null;
	}
}

/**
 * Reset the cached client. Test-only — production code must never call
 * this. Exposed here (rather than via an internal hook) so per-module
 * vitest suites can swap fixtures between runs without leaking state.
 * @internal
 */
function __resetRedisClientForTests(): void {
	redisClient = null;
	redisAvailable = null;
}
