/**
 * Internal-Only Middleware
 *
 * Restricts access to the wrapper service based on network origin and API key auth.
 *
 * DEPLOYMENT MODEL (Production):
 * mcp-stdio-wrapper runs as a standalone Container App with external HTTPS ingress.
 * - Temporal worker calls it over the internal network (private IPs → auto-allowed)
 * - Vercel web app calls it over the public internet (requires API key auth)
 *
 * SECURITY MODEL:
 * - Private IPs / localhost: Allowed without API key (internal network trusted)
 * - Public IPs: Allowed only when MCP_WRAPPER_API_KEY is configured
 *   (the downstream internalApiKeyMiddleware validates the actual key)
 * - No API key configured + public IP: Rejected in production
 *
 * The header-based checks (x-ms-client-request-id, etc.) are NOT trusted as primary
 * auth because they can be spoofed. They're only used as secondary indicators.
 */

import { createHash, timingSafeEqual } from "node:crypto";
import type { Context, MiddlewareHandler } from "hono";

const isProduction = process.env.NODE_ENV === "production";

/**
 * List of allowed IP ranges for internal traffic.
 * In Azure Container Apps, internal traffic comes from the environment's internal IP range.
 */
const ALLOWED_IP_PREFIXES = [
	"10.", // Private Class A
	"172.16.", // Private Class B start
	"172.17.",
	"172.18.",
	"172.19.",
	"172.20.",
	"172.21.",
	"172.22.",
	"172.23.",
	"172.24.",
	"172.25.",
	"172.26.",
	"172.27.",
	"172.28.",
	"172.29.",
	"172.30.",
	"172.31.", // Private Class B end
	"192.168.", // Private Class C
	"127.", // Localhost
	"::1", // IPv6 localhost
];

/**
 * Check if an IP address is internal.
 */
function isInternalIp(ip: string): boolean {
	if (!ip) {
		return false;
	}

	// Check against allowed prefixes
	for (const prefix of ALLOWED_IP_PREFIXES) {
		if (ip.startsWith(prefix)) {
			return true;
		}
	}

	return false;
}

/**
 * Get the client IP from the request.
 */
function getClientIp(c: Context): string | null {
	// Check X-Forwarded-For first (most common in proxied setups)
	const forwarded = c.req.header("x-forwarded-for");
	if (forwarded) {
		// X-Forwarded-For can contain multiple IPs, the first is the original client
		const firstIp = forwarded.split(",")[0]?.trim();
		if (firstIp) {
			return firstIp;
		}
	}

	// Check X-Real-IP
	const realIp = c.req.header("x-real-ip");
	if (realIp) {
		return realIp;
	}

	// Try to get from the socket (may not be available in all environments)
	// In Hono with Node.js, we can access the raw request
	// This is a fallback and may not work in all deployment scenarios
	return null;
}

/**
 * Middleware that restricts access based on network origin.
 *
 * SECURITY:
 * - Private IPs / localhost: Always allowed (internal network)
 * - Public or unknown IPs: Allowed only when MCP_WRAPPER_API_KEY is configured
 *   (downstream API key middleware validates the actual key value)
 * - In development: Can be disabled via ALLOW_EXTERNAL_ACCESS=true
 *
 * This ensures the service is protected when running as a standalone container app:
 * - Temporal worker calls from Azure VNet arrive with private IPs → auto-allowed
 * - Vercel web app calls arrive with public IPs → allowed if API key auth is configured
 * - Without API key configured: public/unknown IPs are rejected in production
 */
export function internalOnlyMiddleware(): MiddlewareHandler {
	return async (c, next) => {
		// Allow disabling for development only
		if (!isProduction && process.env.ALLOW_EXTERNAL_ACCESS === "true") {
			console.log(
				"[Internal-Only] External access allowed via env var (dev mode)",
			);
			return next();
		}

		// Primary check: Client IP must be from private network
		const clientIp = getClientIp(c);
		if (clientIp && isInternalIp(clientIp)) {
			return next();
		}

		// Allow localhost connections via host header (sidecar mode or local dev)
		const host = c.req.header("host");
		if (host && (host.includes("localhost") || host.startsWith("127."))) {
			return next();
		}

		// For unknown or public IPs, allow through if API key auth is configured
		// The downstream internalApiKeyMiddleware will validate the actual key
		const hasApiKeyAuth = !!process.env.MCP_WRAPPER_API_KEY;

		if (hasApiKeyAuth) {
			// API key middleware will handle authentication
			console.log(
				`[Internal-Only] Non-internal IP (${clientIp || "unknown"}) but API key auth configured - allowing (will be authenticated)`,
			);
			return next();
		}

		// No API key configured - reject in production, warn in development
		if (isProduction) {
			console.warn(
				`[Internal-Only] Rejecting: IP ${clientIp || "unknown"} is not internal and no API key auth configured`,
			);
			return c.json(
				{
					error: "Forbidden",
					message:
						"Cannot verify access - configure MCP_WRAPPER_API_KEY or ensure internal network access",
				},
				403,
			);
		}

		// In development, allow with warning
		console.warn(
			`[Internal-Only] IP ${clientIp || "unknown"} is not internal - allowing in dev mode (configure MCP_WRAPPER_API_KEY for production)`,
		);
		return next();
	};
}

/**
 * Constant-time secret comparison (SOC 2 CC6.1). Both sides are hashed to a
 * fixed-length SHA-256 digest first, so the compare never leaks length through
 * an early return and never throws on a length mismatch (`timingSafeEqual`
 * requires equal-length buffers). Empty on either side → false (fail closed).
 */
function constantTimeEqual(provided: string, expected: string): boolean {
	if (!provided || !expected) {
		return false;
	}
	const a = createHash("sha256").update(provided).digest();
	const b = createHash("sha256").update(expected).digest();
	return timingSafeEqual(a, b);
}

/**
 * Optional middleware to require an API key for additional security.
 * The API key is passed via X-Internal-API-Key header.
 */
export function internalApiKeyMiddleware(apiKey: string): MiddlewareHandler {
	return async (c, next) => {
		const providedKey = c.req.header("x-internal-api-key");

		if (!providedKey || !constantTimeEqual(providedKey, apiKey)) {
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
