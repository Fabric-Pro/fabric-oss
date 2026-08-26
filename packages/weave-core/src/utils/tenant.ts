/**
 * Tenant validation utilities
 *
 * Enforces Fabric's XOR tenancy pattern
 */

import type { TenantContext } from "../types/index.js";

/**
 * Validate tenant context is complete
 */
export function validateTenantAccess(context: TenantContext): void {
	if (!context.userId) {
		throw new Error("TenantContext: userId is required");
	}

	// organizationId can be null (personal context) or a string (org context)
	// XOR pattern: exactly one of organizationId or personal context is valid
}

/**
 * Create XOR tenant filter for database queries
 *
 * NEVER use OR between userId and organizationId - that's a data leak.
 * Use XOR: either organization context OR personal context, never both.
 */
export function xorTenantFilter(tenantContext: TenantContext): {
	userId: string;
	organizationId: string | null;
} {
	const { userId, organizationId } = tenantContext;

	// XOR pattern: Exclusive filter
	// If organizationId exists: filter by org (and user for membership check)
	// If organizationId is null: filter by user only (personal context)
	return organizationId
		? { userId, organizationId }
		: { userId, organizationId: null };
}
