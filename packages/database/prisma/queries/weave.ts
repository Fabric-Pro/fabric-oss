/**
 * Weave Query Helpers
 *
 * Tenant filter helper used by weave-related code.
 * Individual procedures and activities use db directly for specific queries.
 */

/**
 * Build XOR tenant filter for weave queries.
 */
export function weaveTenantFilter(
	userId: string,
	organizationId?: string | null,
) {
	return organizationId
		? { userId, organizationId }
		: { userId, organizationId: null };
}
