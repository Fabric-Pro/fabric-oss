import { createHash, timingSafeEqual } from "node:crypto";
import type { MiddlewareHandler } from "hono";

/**
 * Hash both values to fixed-length digests for the timing-safe comparison.
 */
function constantTimeEqual(provided: string, expected: string): boolean {
	const a = createHash("sha256").update(provided).digest();
	const b = createHash("sha256").update(expected).digest();
	return timingSafeEqual(a, b);
}

/**
 * Require the configured key on protected routes. Unkeyed access is available
 * outside production for local development.
 */
export function internalOnlyMiddleware(
	apiKey = process.env.MCP_WRAPPER_API_KEY,
): MiddlewareHandler {
	if (apiKey) {
		return async (c, next) => {
			const providedKey = c.req.header("x-internal-api-key") ?? "";
			if (!constantTimeEqual(providedKey, apiKey)) {
				console.warn("[Internal-API-Key] Invalid or missing API key");
				return c.json(
					{
						error: "Unauthorized",
						message: "Invalid or missing API key",
					},
					401,
				);
			}

			return next();
		};
	}

	if (process.env.NODE_ENV === "production") {
		console.error(
			"[Internal-API-Key] MCP_WRAPPER_API_KEY is missing in production. Protected routes are unavailable.",
		);
		return async (c) =>
			c.json(
				{
					error: "Service unavailable",
					message: "MCP STDIO wrapper is not configured",
				},
				503,
			);
	}

	return (_c, next) => next();
}
