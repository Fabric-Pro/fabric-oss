/**
 * API Key Resolver
 *
 * Resolves API keys to tenant context (user ID, organization ID, scopes).
 * Uses the Runtime API instead of direct database access.
 */

import { getRuntimeClient } from "../runtime-client";
import type { TenantContext } from "../types";

/**
 * Verify an API key and return the tenant context
 *
 * @param apiKey - The API key to verify
 * @param requiredScopes - Optional scopes to validate
 * @returns Tenant context if valid, null if invalid
 * @throws Never throws - returns null for invalid keys
 */
export async function resolveApiKeyToTenant(
	apiKey: string,
	requiredScopes?: string[],
): Promise<TenantContext | null> {
	if (!apiKey || apiKey.length < 20) {
		return null;
	}

	const client = getRuntimeClient();
	return await client.resolveTenant({ apiKey, requiredScopes });
}

/**
 * Check if a tenant has a specific scope
 */
export function hasScope(
	tenant: TenantContext,
	requiredScope: string,
): boolean {
	if (!tenant.scopes) {
		return false;
	}
	return tenant.scopes.includes(requiredScope) || tenant.scopes.includes("*");
}

/**
 * Check if tenant has any of the specified scopes
 */
export function hasAnyScope(
	tenant: TenantContext,
	requiredScopes: string[],
): boolean {
	return requiredScopes.some((scope) => hasScope(tenant, scope));
}
