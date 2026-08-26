/**
 * External API Rate Limiting Middleware
 *
 * Per-API-key rate limiting using the existing rate limit infrastructure.
 */

import type { Context, Next } from "hono";
import { checkRateLimit, RATE_LIMIT_PRESETS } from "../../../lib/rate-limit";
import type { ExternalApiVariables } from "../types";

/**
 * Rate limiting middleware keyed by API key ID.
 * Uses the "agent" preset by default (20 req/min).
 */
export function externalApiRateLimit(
	preset: keyof typeof RATE_LIMIT_PRESETS = "agent",
) {
	const { limit, windowMs } = RATE_LIMIT_PRESETS[preset];

	return async (
		c: Context<{ Variables: ExternalApiVariables }>,
		next: Next,
	) => {
		const ctx = c.get("externalApiContext");
		if (!ctx) {
			// No auth context yet — skip rate limiting (auth middleware will reject)
			await next();
			return;
		}

		const key = `external:${ctx.keyId}`;
		const result = await checkRateLimit(key, limit, windowMs);

		if (result.statusCode !== 503) {
			c.header("X-RateLimit-Limit", limit.toString());
			c.header("X-RateLimit-Remaining", result.remaining.toString());
			c.header("X-RateLimit-Reset", result.resetInSeconds.toString());
		}

		if (!result.allowed) {
			const statusCode = result.statusCode === 503 ? 503 : 429;
			c.header("Retry-After", result.resetInSeconds.toString());
			return c.json(
				{
					error:
						statusCode === 503
							? "Service Unavailable"
							: "Rate limit exceeded",
					retryAfter: result.resetInSeconds,
				},
				statusCode,
			);
		}

		await next();
	};
}
