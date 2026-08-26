/**
 * Tenant Context Middleware
 *
 * This middleware sets up tenant context for all requests based on session data.
 * It uses AsyncLocalStorage to make tenant context available throughout the request lifecycle.
 *
 * Usage:
 * 1. Chain this middleware after authentication
 * 2. Access tenant context anywhere via getTenantContext()
 * 3. Use getTenantDb() for auto-filtered database queries
 */

import { os } from "@orpc/server";
import {
	createOrganizationContext,
	createPersonalContext,
	db,
	runWithTenantContext,
	type TenantContext,
} from "@repo/database";
import type { OrgRole } from "@repo/permissions";

/**
 * Context type expected from authentication middleware
 */
type AuthenticatedContext = {
	session: {
		id: string;
		userId: string;
		activeOrganizationId?: string | null;
	};
	user: {
		id: string;
		email: string;
		name: string;
	};
};

/**
 * Tenant context middleware for ORPC procedures.
 *
 * Sets up AsyncLocalStorage tenant context based on session's activeOrganizationId.
 * - If activeOrganizationId is set: organization context
 * - If activeOrganizationId is null/undefined: personal context
 *
 * @example
 * ```ts
 * export const tenantProtectedProcedure = protectedProcedure.use(
 *   tenantContextMiddleware
 * );
 * ```
 */
export const tenantContextMiddleware = os
	.$context<AuthenticatedContext>()
	.middleware(async ({ context, next }) => {
		const userId = context.user.id;
		const organizationId = context.session.activeOrganizationId;

		// Create the appropriate tenant context
		const tenantContext: TenantContext = organizationId
			? createOrganizationContext(organizationId, userId)
			: createPersonalContext(userId);

		// Resolve the user's role in the active organization (if any).
		// Better Auth stores membership in the `member` table.
		let activeOrganizationRole: OrgRole | null = null;
		if (organizationId) {
			const membership = await db.member.findUnique({
				where: {
					organizationId_userId: { organizationId, userId },
				},
				select: { role: true },
			});
			activeOrganizationRole = (membership?.role ??
				null) as OrgRole | null;
		}

		// Run the rest of the request chain within the tenant context
		return await runWithTenantContext(tenantContext, async () => {
			return await next({
				context: {
					tenantContext,
					activeOrganizationRole,
					allowedProjectIds: [] as string[],
				},
			});
		});
	});

/**
 * Helper to extract organizationId with type safety.
 * Returns organizationId if in org context, null otherwise.
 *
 * @example
 * ```ts
 * const orgId = getOrganizationIdFromContext(context.tenantContext);
 * if (orgId) {
 *   // Organization-specific logic
 * }
 * ```
 */
export function getOrganizationIdFromContext(
	tenantContext: TenantContext,
): string | null {
	return tenantContext.type === "organization"
		? tenantContext.organizationId
		: null;
}

/**
 * Helper to get the tenant filter for manual queries.
 * Use this when you need to manually construct WHERE clauses.
 *
 * @example
 * ```ts
 * const filter = getTenantFilterFromContext(context.tenantContext);
 * const results = await db.mCPConfig.findMany({
 *   where: filter,
 * });
 * ```
 */
export function getTenantFilterFromContext(tenantContext: TenantContext): {
	userId?: string | null;
	organizationId?: string | null;
} {
	if (tenantContext.type === "organization") {
		return {
			organizationId: tenantContext.organizationId,
			userId: null,
		};
	}
	return {
		userId: tenantContext.userId,
		organizationId: null,
	};
}
