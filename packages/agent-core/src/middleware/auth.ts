/**
 * Authentication Middleware for Agent Servers
 *
 * Provides multiple authentication strategies:
 * 1. API Key authentication (for service-to-service)
 * 2. JWT/Bearer token (for user requests via Next.js)
 * 3. HMAC signature (for webhook-style requests)
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import type { Context, Next } from "hono";
import { HTTPException } from "hono/http-exception";

export interface AuthConfig {
	/** API keys allowed to access this service */
	apiKeys?: string[];
	/** JWT secret for token verification */
	jwtSecret?: string;
	/** HMAC secret for signature verification */
	hmacSecret?: string;
	/** Paths to exclude from authentication */
	excludePaths?: string[];
	/** Whether to allow unauthenticated health checks */
	allowHealthCheck?: boolean;
}

/**
 * Verify API key from header
 */
function verifyApiKey(
	authHeader: string | undefined,
	validKeys: string[],
): boolean {
	if (!authHeader) {
		return false;
	}

	// Support both "Bearer <key>" and "ApiKey <key>" formats
	const parts = authHeader.split(" ");
	if (parts.length !== 2) {
		return false;
	}

	const [scheme, key] = parts;
	if (!["Bearer", "ApiKey", "Api-Key"].includes(scheme)) {
		return false;
	}

	return validKeys.includes(key);
}

/**
 * Verify HMAC signature for request body
 */
function verifyHmacSignature(
	body: string,
	signature: string | undefined,
	secret: string,
): boolean {
	if (!signature) {
		return false;
	}

	const expectedSignature = createHmac("sha256", secret)
		.update(body)
		.digest("hex");

	// Use timing-safe comparison to prevent timing attacks
	try {
		return timingSafeEqual(
			Buffer.from(signature, "hex"),
			Buffer.from(expectedSignature, "hex"),
		);
	} catch {
		return false;
	}
}

/**
 * Create authentication middleware for Hono
 */
export function createAuthMiddleware(config: AuthConfig) {
	const excludePaths = new Set([
		...(config.excludePaths || []),
		...(config.allowHealthCheck !== false ? ["/health", "/ok"] : []),
		// A2A discovery endpoint should be public for agent mesh
		"/.well-known/agent.json",
	]);

	return async (c: Context, next: Next) => {
		const path = c.req.path;

		// Skip auth for excluded paths
		if (excludePaths.has(path)) {
			return next();
		}

		// Try API key authentication
		const authHeader = c.req.header("Authorization");
		if (
			config.apiKeys?.length &&
			verifyApiKey(authHeader, config.apiKeys)
		) {
			// Set auth context for downstream handlers
			c.set("authMethod", "apiKey");
			return next();
		}

		// Try X-Agent-Key header (alternative for service-to-service)
		const agentKey = c.req.header("X-Agent-Key");
		if (
			config.apiKeys?.length &&
			agentKey &&
			config.apiKeys.includes(agentKey)
		) {
			c.set("authMethod", "agentKey");
			return next();
		}

		// Try HMAC signature verification
		if (config.hmacSecret) {
			const signature = c.req.header("X-Signature-256");
			const body = await c.req.text();
			if (verifyHmacSignature(body, signature, config.hmacSecret)) {
				c.set("authMethod", "hmac");
				return next();
			}
		}

		// No valid authentication found
		throw new HTTPException(401, {
			message: "Unauthorized: Valid authentication required",
		});
	};
}

/**
 * Environment-based auth config loader
 */
export function loadAuthConfigFromEnv(): AuthConfig {
	// AGENT_API_KEY is canonical; AGENT_API_KEYS is accepted as a back-compat
	// alias. Empty/whitespace-only values are treated as unset so an
	// accidentally-blank AGENT_API_KEY can't override a real AGENT_API_KEYS.
	const apiKeysRaw =
		process.env.AGENT_API_KEY?.trim() || process.env.AGENT_API_KEYS?.trim();
	const apiKeys =
		apiKeysRaw
			?.split(",")
			.map((k) => k.trim())
			.filter(Boolean) ?? [];
	const hmacSecret = process.env.AGENT_HMAC_SECRET?.trim() || undefined;

	return {
		apiKeys: apiKeys.length > 0 ? apiKeys : undefined,
		hmacSecret,
		allowHealthCheck: true,
	};
}

/**
 * Check if auth is enabled (any auth method configured)
 */
export function isAuthEnabled(config: AuthConfig): boolean {
	return !!(
		(config.apiKeys?.length ?? 0) > 0 ||
		config.jwtSecret ||
		config.hmacSecret
	);
}
