/**
 * XOR tenant filter helpers for code paths that operate outside the oRPC
 * request lifecycle (Temporal activities, background jobs, cron handlers).
 *
 * oRPC procedures should use `getTenantDb()` or
 * `getTenantFilterFromContext()` — those read tenant context from the
 * request's AsyncLocalStorage. These helpers are for places that receive
 * `userId` / `organizationId` as function arguments and need to build the
 * Prisma `where` clause by hand.
 */

/**
 * Build the USER_OWNED tenant-filter fragment:
 *  - Org context: `{ organizationId }` — every member sees all org data.
 *  - Personal context: `{ userId, organizationId: null }` — user's own rows,
 *    never anything attached to an org.
 *
 * Matches the semantics of `USER_OWNED_TABLES` in `tenant-db.ts`.
 */
export function tenantWhere(
	userId: string,
	organizationId?: string | null,
): { organizationId: string } | { userId: string; organizationId: null } {
	return organizationId
		? { organizationId }
		: { userId, organizationId: null };
}

/**
 * Build the PER_USER_IN_ORG tenant-filter fragment. Unlike `tenantWhere`,
 * both branches include `userId` so an org member cannot read another
 * member's private rows (AI chats, browser tasks, agent conversations,
 * per-user project preferences, etc.).
 *
 * Matches the semantics of `PER_USER_ORG_TABLES` in `tenant-db.ts`.
 */
export function perUserTenantWhere(
	userId: string,
	organizationId?: string | null,
):
	| { organizationId: string; userId: string }
	| { userId: string; organizationId: null } {
	return organizationId
		? { organizationId, userId }
		: { userId, organizationId: null };
}
