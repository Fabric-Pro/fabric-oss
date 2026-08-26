/**
 * Rate Limiting Middleware for API
 * Provides configurable rate limiting with support for both:
 * - In-memory store (single instance, development)
 * - Redis/Upstash store (multi-instance, production)
 * Automatically uses Redis when UPSTASH_REDIS_REST_URL is configured.
 */

import { logger } from "@repo/logs";
import { Ratelimit } from "@upstash/ratelimit";
import { getRedisClient } from "./redis-client";

interface RateLimitEntry {
	count: number;
	resetTime: number;
}

// In-memory store for rate limiting (fallback when Redis not available)
const rateLimitStore = new Map<string, RateLimitEntry>();

// Cleanup interval to prevent memory leaks
const CLEANUP_INTERVAL_MS = 60_000; // 1 minute

let cleanupInterval: ReturnType<typeof setInterval> | null = null;

// Upstash rate limiters cache (one per config)
const upstashRateLimiters = new Map<string, Ratelimit>();

/**
 * Get or create an Upstash rate limiter for a specific configuration.
 * Reuses the shared Redis client from `redis-client.ts` so the rate
 * limiter and other Upstash-backed features (e.g. AI usage-limit
 * counters) share connection state.
 */
function getUpstashRateLimiter(
	limit: number,
	windowMs: number,
): Ratelimit | null {
	const redis = getRedisClient();
	if (!redis) {
		return null;
	}

	const key = `${limit}:${windowMs}`;
	let limiter = upstashRateLimiters.get(key);

	if (!limiter) {
		// Convert windowMs to seconds for Upstash
		const windowSeconds = Math.ceil(windowMs / 1000);

		limiter = new Ratelimit({
			redis,
			limiter: Ratelimit.slidingWindow(limit, `${windowSeconds} s`),
			analytics: true,
			prefix: "fabric:ratelimit",
		});

		upstashRateLimiters.set(key, limiter);
	}

	return limiter;
}

function startCleanup() {
	if (cleanupInterval) {
		return;
	}

	cleanupInterval = setInterval(() => {
		const now = Date.now();
		for (const [key, entry] of rateLimitStore.entries()) {
			if (entry.resetTime <= now) {
				rateLimitStore.delete(key);
			}
		}
	}, CLEANUP_INTERVAL_MS);

	// Don't prevent process exit
	if (cleanupInterval.unref) {
		cleanupInterval.unref();
	}
}

/**
 * Default rate limit configurations for different endpoint types
 */
export const RATE_LIMIT_PRESETS = {
	/** Standard API endpoints - 100 requests per minute */
	standard: {
		limit: 100,
		windowMs: 60_000,
	},
	/** Strict rate limit for expensive operations - 10 per minute */
	strict: {
		limit: 10,
		windowMs: 60_000,
	},
	/** Very strict for login/auth attempts - 5 per minute */
	auth: {
		limit: 5,
		windowMs: 60_000,
	},
	/** Public endpoints (contact forms, etc.) - 3 per minute */
	public: {
		limit: 3,
		windowMs: 60_000,
	},
	/** AI/LLM operations - expensive, 20 per minute */
	ai: {
		limit: 20,
		windowMs: 60_000,
	},
	/** AI search-as-you-type — one cheap query embedding per call, but a
	 * typing session legitimately produces a request per debounced pause, so
	 * the budget is wider than `ai` (whose 20/min was sized for LLM calls
	 * ~1000x costlier). */
	aiSearch: {
		limit: 60,
		windowMs: 60_000,
	},
	/** Workflow execution - 30 per minute */
	workflow: {
		limit: 30,
		windowMs: 60_000,
	},
	/** Agent execution - 20 per minute */
	agent: {
		limit: 20,
		windowMs: 60_000,
	},
	/** Webhook triggers - 60 per minute */
	webhook: {
		limit: 60,
		windowMs: 60_000,
	},
	/**
	 * Public audit-log REST API — 600 requests/min per API key.
	 *
	 * Higher than `standard` (100/min) because the dominant client is a
	 * server-to-server integration (e.g. an SRE's local CLI doing a
	 * full-trail walk via `nextCursor`) where 100/min would force the
	 * caller to space out reads artificially. Lower than the implicit
	 * "no limit" so a hostile key cannot trivially DoS the audit table.
	 *
	 * Spec: public audit-log REST API instructions.
	 */
	auditExternal: {
		limit: 600,
		windowMs: 60_000,
	},
} as const;

/**
 * In-memory rate limit check
 */
function checkInMemoryRateLimit(
	key: string,
	limit: number,
	windowMs: number,
): {
	allowed: boolean;
	remaining: number;
	resetInSeconds: number;
	statusCode?: number;
	reason?: "ratelimit-unavailable";
} {
	startCleanup();

	const now = Date.now();
	let entry = rateLimitStore.get(key);

	if (!entry || entry.resetTime <= now) {
		entry = {
			count: 1,
			resetTime: now + windowMs,
		};
		rateLimitStore.set(key, entry);
	} else {
		entry.count++;
	}

	const remaining = Math.max(0, limit - entry.count);
	const resetInSeconds = Math.ceil((entry.resetTime - now) / 1000);

	return {
		allowed: entry.count <= limit,
		remaining,
		resetInSeconds,
	};
}

/**
 * Redis rate limit check using Upstash
 */
async function checkRedisRateLimit(
	key: string,
	limit: number,
	windowMs: number,
): Promise<{
	allowed: boolean;
	remaining: number;
	resetInSeconds: number;
	statusCode?: number;
	reason?: "ratelimit-unavailable";
}> {
	const limiter = getUpstashRateLimiter(limit, windowMs);

	if (!limiter) {
		if (process.env.NODE_ENV === "production") {
			logger.error(
				{ event: "ratelimit.redis.unavailable", reason: "no-limiter" },
				"Redis rate limiter unavailable in production — failing closed",
			);
			return {
				allowed: false,
				remaining: 0,
				resetInSeconds: 60,
				statusCode: 503,
				reason: "ratelimit-unavailable",
			};
		}
		// Dev/test: fallback to in-memory
		return checkInMemoryRateLimit(key, limit, windowMs);
	}

	try {
		const result = await limiter.limit(key);

		return {
			allowed: result.success,
			remaining: result.remaining,
			resetInSeconds: Math.ceil((result.reset - Date.now()) / 1000),
		};
	} catch (error) {
		if (process.env.NODE_ENV === "production") {
			logger.error(
				{ event: "ratelimit.redis.unavailable", error: String(error) },
				"Redis unavailable in production — failing closed",
			);
			return {
				allowed: false,
				remaining: 0,
				resetInSeconds: 60,
				statusCode: 503,
				reason: "ratelimit-unavailable",
			};
		}
		console.error(
			"[RateLimit] Redis error, falling back to in-memory:",
			error,
		);
		// Dev/test: fallback to in-memory on Redis failure
		return checkInMemoryRateLimit(key, limit, windowMs);
	}
}

/**
 * Utility to check rate limit without middleware
 * Useful for checking limits in procedure handlers
 */
export async function checkRateLimit(
	key: string,
	limit: number,
	windowMs: number,
): Promise<{
	allowed: boolean;
	remaining: number;
	resetInSeconds: number;
	statusCode?: number;
	reason?: "ratelimit-unavailable";
}> {
	const redisClientInstance = getRedisClient();

	if (redisClientInstance !== null) {
		return checkRedisRateLimit(key, limit, windowMs);
	}

	// Redis not configured at all
	if (process.env.NODE_ENV === "production") {
		logger.error(
			{ event: "ratelimit.redis.unavailable", reason: "no-client" },
			"Redis rate limiter unavailable in production — failing closed",
		);
		return {
			allowed: false,
			remaining: 0,
			resetInSeconds: 60,
			statusCode: 503,
			reason: "ratelimit-unavailable",
		};
	}

	return checkInMemoryRateLimit(key, limit, windowMs);
}

/**
 * Synchronous version for non-async contexts (uses in-memory only)
 */
export function checkRateLimitSync(
	key: string,
	limit: number,
	windowMs: number,
): {
	allowed: boolean;
	remaining: number;
	resetInSeconds: number;
	statusCode?: number;
	reason?: "ratelimit-unavailable";
} {
	return checkInMemoryRateLimit(key, limit, windowMs);
}

/**
 * Clear rate limit for a specific key
 * Works with both in-memory and Redis
 */
export async function clearRateLimit(key: string): Promise<void> {
	// Clear from in-memory
	rateLimitStore.delete(key);

	// Clear from Redis if available
	const redis = getRedisClient();
	if (redis) {
		try {
			// Delete all keys matching this pattern from Upstash
			const pattern = `fabric:ratelimit:${key}*`;
			const keys = await redis.keys(pattern);
			if (keys.length > 0) {
				await redis.del(...keys);
			}
		} catch (error) {
			console.error("[RateLimit] Failed to clear Redis key:", error);
		}
	}
}

/**
 * Get current rate limit stats (for monitoring)
 */
export function getRateLimitStats(): {
	totalKeys: number;
	memoryEntries: number;
	backend: "redis" | "memory";
	redisAvailable: boolean;
} {
	const redisActive = getRedisClient() !== null;
	return {
		totalKeys: rateLimitStore.size,
		memoryEntries: rateLimitStore.size,
		backend: redisActive ? "redis" : "memory",
		redisAvailable: redisActive,
	};
}
