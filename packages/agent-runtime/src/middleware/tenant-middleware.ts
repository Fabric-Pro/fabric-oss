/**
 * Tenant Middleware
 *
 * Hono middleware for extracting and validating tenant context from requests.
 * Supports both API key authentication and session-based authentication.
 */

import type { Context, MiddlewareHandler, Next } from "hono";
import {
	hasScope,
	resolveApiKeyToTenant,
} from "../model-resolver/api-key-resolver";
import type { TenantContext } from "../types";

// Extend Hono's context types
declare module "hono" {
	interface ContextVariableMap {
		tenant: TenantContext;
	}
}

/**
 * Extract API key from request
 * Supports: Authorization header (Bearer), X-API-Key header, query parameter
 */
function extractApiKey(c: Context): string | null {
	// Try Authorization header
	const authHeader = c.req.header("Authorization");
	if (authHeader?.startsWith("Bearer ")) {
		return authHeader.slice(7);
	}

	// Try X-API-Key header
	const apiKeyHeader = c.req.header("X-API-Key");
	if (apiKeyHeader) {
		return apiKeyHeader;
	}

	// Try query parameter (for webhook callbacks)
	const queryKey = c.req.query("apiKey");
	if (queryKey) {
		return queryKey;
	}

	return null;
}

/**
 * Tenant authentication middleware
 *
 * Extracts and validates tenant context from the request.
 * Sets the tenant in context for downstream handlers.
 *
 * @param requiredScopes - Optional array of required scopes
 */
export function tenantAuth(requiredScopes?: string[]): MiddlewareHandler {
	return async (c: Context, next: Next) => {
		const apiKey = extractApiKey(c);

		if (!apiKey) {
			return c.json(
				{
					error: "UNAUTHORIZED",
					message:
						"API key is required. Provide via Authorization header (Bearer) or X-API-Key header.",
				},
				401,
			);
		}

		const tenant = await resolveApiKeyToTenant(apiKey);

		if (!tenant) {
			return c.json(
				{
					error: "UNAUTHORIZED",
					message: "Invalid or expired API key",
				},
				401,
			);
		}

		// Check required scopes
		if (requiredScopes && requiredScopes.length > 0) {
			const hasAllScopes = requiredScopes.every((scope) =>
				hasScope(tenant, scope),
			);
			if (!hasAllScopes) {
				return c.json(
					{
						error: "FORBIDDEN",
						message: `Missing required scopes: ${requiredScopes.join(", ")}`,
						requiredScopes,
						grantedScopes: tenant.scopes,
					},
					403,
				);
			}
		}

		// Set tenant in context
		c.set("tenant", tenant);

		return await next();
	};
}

/**
 * Optional tenant middleware
 *
 * Attempts to extract tenant context but doesn't require it.
 * Useful for endpoints that support both authenticated and anonymous access.
 */
export function optionalTenantAuth(): MiddlewareHandler {
	return async (c: Context, next: Next) => {
		const apiKey = extractApiKey(c);

		if (apiKey) {
			const tenant = await resolveApiKeyToTenant(apiKey);
			if (tenant) {
				c.set("tenant", tenant);
			}
		}

		return await next();
	};
}

/**
 * Get tenant from context (throws if not authenticated)
 */
export function getTenant(c: Context): TenantContext {
	const tenant = c.get("tenant");
	if (!tenant) {
		throw new Error(
			"Tenant not found in context. Ensure tenantAuth middleware is applied.",
		);
	}
	return tenant;
}

/**
 * Get optional tenant from context (returns null if not authenticated)
 */
export function getOptionalTenant(c: Context): TenantContext | null {
	return c.get("tenant") ?? null;
}
