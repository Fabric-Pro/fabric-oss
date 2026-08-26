/**
 * Rate Limiting Middleware for Agent Servers
 *
 * Simple in-memory rate limiting. For production, consider using
 * Redis-based rate limiting for distributed deployments.
 */

import type { Context, Next } from "hono";
import { HTTPException } from "hono/http-exception";

interface RateLimitConfig {
	/** Maximum requests per window */
	maxRequests: number;
	/** Window size in milliseconds */
	windowMs: number;
	/** Key extractor function (default: IP-based) */
	keyExtractor?: (c: Context) => string;
	/** Paths to exclude from rate limiting */
	excludePaths?: string[];
}

interface RateLimitEntry {
	count: number;
	resetAt: number;
}

const rateLimitStore = new Map<string, RateLimitEntry>();

// Cleanup old entries periodically
setInterval(() => {
	const now = Date.now();
	for (const [key, entry] of rateLimitStore.entries()) {
		if (entry.resetAt < now) {
			rateLimitStore.delete(key);
		}
	}
}, 60000); // Cleanup every minute

/**
 * Default key extractor - uses IP address
 */
function defaultKeyExtractor(c: Context): string {
	return (
		c.req.header("X-Forwarded-For")?.split(",")[0]?.trim() ||
		c.req.header("X-Real-IP") ||
		"unknown"
	);
}

/**
 * Create rate limiting middleware
 */
export function createRateLimitMiddleware(config: RateLimitConfig) {
	const {
		maxRequests,
		windowMs,
		keyExtractor = defaultKeyExtractor,
		excludePaths = [],
	} = config;

	const excludeSet = new Set([...excludePaths, "/health", "/ok"]);

	return async (c: Context, next: Next) => {
		const path = c.req.path;

		// Skip rate limiting for excluded paths
		if (excludeSet.has(path)) {
			return next();
		}

		const key = keyExtractor(c);
		const now = Date.now();

		let entry = rateLimitStore.get(key);

		if (!entry || entry.resetAt < now) {
			// Create new window
			entry = {
				count: 1,
				resetAt: now + windowMs,
			};
			rateLimitStore.set(key, entry);
		} else {
			entry.count++;
		}

		// Set rate limit headers
		c.header("X-RateLimit-Limit", maxRequests.toString());
		c.header(
			"X-RateLimit-Remaining",
			Math.max(0, maxRequests - entry.count).toString(),
		);
		c.header(
			"X-RateLimit-Reset",
			Math.ceil(entry.resetAt / 1000).toString(),
		);

		if (entry.count > maxRequests) {
			throw new HTTPException(429, {
				message: "Too Many Requests: Rate limit exceeded",
			});
		}

		return next();
	};
}

/**
 * Environment-based rate limit config loader
 */
export function loadRateLimitConfigFromEnv(): RateLimitConfig {
	return {
		maxRequests: Number.parseInt(
			process.env.RATE_LIMIT_MAX_REQUESTS || "100",
			10,
		),
		windowMs: Number.parseInt(
			process.env.RATE_LIMIT_WINDOW_MS || "60000",
			10,
		),
	};
}
