/**
 * API Key Authentication Library
 *
 * Validates API keys and returns tenant context.
 * This is the server-side implementation that agents call via HTTP.
 */

import { createHash } from "node:crypto";
import { db } from "@repo/database";
import type { TenantContext } from "../types";

/**
 * Validate an API key and return the tenant context
 *
 * @param apiKey - The API key to validate
 * @returns Tenant context if valid, null if invalid
 */
export async function validateApiKey(
	apiKey: string,
): Promise<TenantContext | null> {
	if (!apiKey || apiKey.length < 20) {
		return null;
	}

	// Hash the provided key
	const keyHash = createHash("sha256").update(apiKey).digest("hex");

	// Try user API key first
	const userApiKey = await db.userApiKey.findFirst({
		where: {
			keyHash,
			isActive: true,
			OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
		},
		select: {
			id: true,
			userId: true,
			scopes: true,
		},
	});

	if (userApiKey) {
		// Update last used timestamp (fire and forget)
		db.userApiKey
			.update({
				where: { id: userApiKey.id },
				data: {
					lastUsedAt: new Date(),
					usageCount: { increment: 1 },
				},
			})
			.catch(() => {}); // Ignore errors

		return {
			userId: userApiKey.userId,
			organizationId: null,
			apiKeyId: userApiKey.id,
			scopes: userApiKey.scopes,
		};
	}

	// Try organization API key
	const orgApiKey = await db.organizationApiKey.findFirst({
		where: {
			keyHash,
			isActive: true,
			OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
		},
		select: {
			id: true,
			organizationId: true,
			createdByUserId: true,
			scopes: true,
		},
	});

	if (orgApiKey) {
		// Update last used timestamp (fire and forget)
		db.organizationApiKey
			.update({
				where: { id: orgApiKey.id },
				data: {
					lastUsedAt: new Date(),
					usageCount: { increment: 1 },
				},
			})
			.catch(() => {}); // Ignore errors

		return {
			userId: orgApiKey.createdByUserId,
			organizationId: orgApiKey.organizationId,
			apiKeyId: orgApiKey.id,
			scopes: orgApiKey.scopes,
		};
	}

	return null;
}

/**
 * Check if tenant has a specific scope
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
