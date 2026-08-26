/**
 * Auth Rate Limiting Middleware
 *
 * Applies endpoint-specific rate limits to authentication routes.
 * Runs as Hono middleware before the Better Auth handler to throttle
 * high-volume automated requests against auth endpoints.
 *
 * Uses the existing rate limiting infrastructure (Redis in production,
 * in-memory fallback in development).
 */

import { getTrustedClientIp } from "@repo/auth/lib/client-ip";
import { logger } from "@repo/logs";
import type { Context, MiddlewareHandler, Next } from "hono";
import { checkRateLimit } from "./rate-limit";

/**
 * Rate limit configuration per auth endpoint.
 * Keys are path suffixes matched against the request URL.
 */
export const AUTH_RATE_LIMITS: Record<
	string,
	{ limit: number; windowMs: number; keyPrefix: string }
> = {
	"/sign-in/email": {
		limit: 20,
		windowMs: 60_000,
		keyPrefix: "auth:signin",
	},
	"/sign-up/email": {
		limit: 20,
		windowMs: 60_000,
		keyPrefix: "auth:signup",
	},
	"/request-password-reset": {
		limit: 20,
		windowMs: 60_000,
		keyPrefix: "auth:forgot",
	},
	"/magic-link": {
		limit: 20,
		windowMs: 60_000,
		keyPrefix: "auth:magic",
	},
	"/two-factor": {
		limit: 20,
		windowMs: 60_000,
		keyPrefix: "auth:2fa",
	},
};

/**
 * Extract client IP from request headers using the shared trusted-proxy
 * helper. If no trusted ingress header is present, fall back to a
 * user-agent/accept-language fingerprint so rate-limit buckets stay split
 * across unrelated clients rather than collapsing into one bucket.
 */
function getClientIp(c: Context): string {
	const trusted = getTrustedClientIp(c.req.raw.headers);
	if (trusted !== "unknown") {
		return trusted;
	}

	const userAgent = c.req.header("user-agent") || "unknown";
	const acceptLang = c.req.header("accept-language") || "unknown";
	return `fingerprint:${simpleHash(userAgent + acceptLang)}`;
}

function simpleHash(str: string): string {
	let hash = 0;
	for (let i = 0; i < str.length; i++) {
		const char = str.charCodeAt(i);
		hash = (hash << 5) - hash + char;
		hash = hash & hash;
	}
	return hash.toString(36);
}

/**
 * Find the matching rate limit config for a given request path.
 * Returns null if no auth rate limit applies to this path.
 */
function findRateLimitConfig(
	path: string,
): { limit: number; windowMs: number; keyPrefix: string } | null {
	for (const [pattern, config] of Object.entries(AUTH_RATE_LIMITS)) {
		if (path.includes(pattern)) {
			return config;
		}
	}
	return null;
}

/**
 * Creates a Hono middleware that applies per-IP rate limits to
 * authentication endpoints.
 *
 * Non-auth routes and auth routes without a specific rate limit config
 * pass through with zero additional latency (early return before any
 * async work).
 *
 * When a rate limit is exceeded, returns HTTP 429 with a JSON body
 * and sets standard rate limit headers including Retry-After.
 */
export function authRateLimitMiddleware(): MiddlewareHandler {
	return async (c: Context, next: Next) => {
		const path = c.req.path;

		// Only apply to auth routes - strip the /api prefix for matching
		const authPath = path.replace(/^\/api\/auth/, "");

		// If the path didn't change, this isn't an auth route - skip entirely
		if (authPath === path) {
			await next();
			return;
		}

		const config = findRateLimitConfig(authPath);

		// No rate limit config for this auth endpoint - pass through
		if (!config) {
			await next();
			return;
		}

		const clientIp = getClientIp(c);
		const rateLimitKey = `${config.keyPrefix}:${clientIp}`;

		const result = await checkRateLimit(
			rateLimitKey,
			config.limit,
			config.windowMs,
		);

		const is503 = result.statusCode === 503;

		// Skip rate-limit semantic headers when the rate-limit service is
		// unavailable — they would mislead clients into rate-limit retry logic
		// instead of recognising service degradation.
		if (!is503) {
			c.header("X-RateLimit-Limit", config.limit.toString());
			c.header("X-RateLimit-Remaining", result.remaining.toString());
			c.header("X-RateLimit-Reset", result.resetInSeconds.toString());
		}

		if (!result.allowed) {
			const statusCode = is503 ? 503 : 429;
			const errorTitle = is503
				? "Service Unavailable"
				: "Too many requests";
			const message = is503
				? "Rate limit service temporarily unavailable"
				: `Rate limit exceeded. Please try again in ${result.resetInSeconds} seconds.`;

			c.header("Retry-After", result.resetInSeconds.toString());

			logger.warn(
				{
					event: is503
						? "auth.ratelimit.unavailable"
						: "auth.ratelimit.exceeded",
					security: true,
					ip: clientIp,
					endpoint: authPath,
					limit: config.limit,
					window: config.windowMs,
				},
				is503
					? "Auth rate limit service unavailable"
					: "Auth rate limit exceeded",
			);

			return c.json(
				{
					error: errorTitle,
					message,
					retryAfter: result.resetInSeconds,
				},
				statusCode,
			);
		}

		await next();
	};
}
