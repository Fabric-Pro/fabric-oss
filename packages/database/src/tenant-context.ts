/**
 * Tenant Context Module
 *
 * Provides request-scoped tenant context using AsyncLocalStorage.
 * This allows tenant information to flow through async operations
 * without explicitly passing it through every function call.
 *
 * Usage:
 *   // In middleware
 *   runWithTenantContext({ type: 'organization', tenantId: 'org-123', userId: 'user-456' }, async () => {
 *     // All database queries in this context will be tenant-isolated
 *     await someHandler(req, res);
 *   });
 *
 *   // In any code
 *   const ctx = getTenantContext();
 *   if (ctx.type === 'organization') {
 *     // Organization context
 *   }
 */

import { AsyncLocalStorage } from "node:async_hooks";

// ============================================================================
// Types
// ============================================================================

export type TenantType = "organization" | "personal" | "none";

export interface TenantContext {
	/** The type of tenant context */
	type: TenantType;
	/** The tenant ID (organization ID for org context, user ID for personal context) */
	tenantId: string | null;
	/** The user ID (always present when authenticated) */
	userId: string | null;
	/** The organization ID (only present in org context) */
	organizationId: string | null;
	/**
	 * Project IDs for which this request has been granted explicit access by
	 * the permission middleware (e.g. an accepted external guest accessing a
	 * project in an org they do not belong to). When non-empty, queries
	 * against project-scoped tables allow rows whose `projectId` is in this
	 * list *in addition to* the normal tenant filter.
	 *
	 * Populated at request time by `grantProjectAccess`. Mutable for the
	 * duration of a single request — do not freeze.
	 *
	 * Default: empty array — unchanged behavior for all existing callers.
	 */
	allowedProjectIds: string[];
	/**
	 * Organization id to use when a guest creates data inside an invited
	 * project. Populated by `grantProjectAccess` alongside the project id.
	 * `resolveOrganizationId` falls back to this value when the session has
	 * no active organization, so create procedures get the right org
	 * automatically without any per-procedure change.
	 *
	 * Default: null. Set only in the guest-path branch of
	 * `requireProjectPermission`.
	 */
	effectiveWriteOrgId: string | null;
}

// ============================================================================
// AsyncLocalStorage Instance
// ============================================================================

const tenantStorage = new AsyncLocalStorage<TenantContext>();

// Default context when none is set
const DEFAULT_CONTEXT: TenantContext = {
	type: "none",
	tenantId: null,
	userId: null,
	organizationId: null,
	allowedProjectIds: [],
	effectiveWriteOrgId: null,
};

// ============================================================================
// Public API
// ============================================================================

/**
 * Get the current tenant context.
 * Returns a default "none" context if not in a tenant-scoped execution.
 */
export function getTenantContext(): TenantContext {
	return tenantStorage.getStore() ?? DEFAULT_CONTEXT;
}

/**
 * Check if we're currently in a valid tenant context.
 */
export function hasTenantContext(): boolean {
	const ctx = getTenantContext();
	return ctx.type !== "none" && ctx.tenantId !== null;
}

/**
 * Check if we're in an organization context.
 */
export function isOrganizationContext(): boolean {
	return getTenantContext().type === "organization";
}

/**
 * Check if we're in a personal context.
 */
export function isPersonalContext(): boolean {
	return getTenantContext().type === "personal";
}

/**
 * Get the current organization ID (null if not in org context).
 */
export function getCurrentOrganizationId(): string | null {
	const ctx = getTenantContext();
	return ctx.type === "organization" ? ctx.organizationId : null;
}

/**
 * Get the current user ID.
 */
export function getCurrentUserId(): string | null {
	return getTenantContext().userId;
}

/**
 * Run a function with the specified tenant context.
 * All async operations within the callback will have access to this context.
 */
export function runWithTenantContext<T>(
	context: TenantContext,
	callback: () => T,
): T {
	return tenantStorage.run(context, callback);
}

/**
 * Create a tenant context for an organization.
 */
export function createOrganizationContext(
	organizationId: string,
	userId: string,
): TenantContext {
	return {
		type: "organization",
		tenantId: organizationId,
		userId,
		organizationId,
		allowedProjectIds: [],
		effectiveWriteOrgId: null,
	};
}

/**
 * Create a tenant context for a personal account.
 */
export function createPersonalContext(userId: string): TenantContext {
	return {
		type: "personal",
		tenantId: userId,
		userId,
		organizationId: null,
		allowedProjectIds: [],
		effectiveWriteOrgId: null,
	};
}

/**
 * Grant the current request access to a specific project, in addition to the
 * normal tenant filter. Safe to call multiple times; duplicates are ignored.
 *
 * ⚠️  AUTHORIZATION CONTRACT — DO NOT CALL FROM PROCEDURE HANDLERS.
 *
 * This function is the privileged escalation point that widens the request's
 * visible data beyond the normal tenant filter. It must ONLY be called from
 * middleware that has *already* verified the caller has a valid accepted
 * `ProjectMember` row for the project (see
 * `packages/api/orpc/middleware/require-permission.ts:requireProjectPermission`
 * Path C). A procedure handler that calls this directly could bypass the
 * ProjectMember check entirely and leak cross-tenant data.
 *
 * This mutates the TenantContext object in AsyncLocalStorage — legal because
 * the object is request-scoped and there are no cross-request references.
 * The `allowedProjectIds` array must NOT be frozen by callers; do not pass
 * `Object.freeze`d arrays into `runWithTenantContext`.
 *
 * The optional `organizationId` parameter captures the invited project's
 * host organization. When set, it becomes the default org id for writes
 * inside this request — the guest's create procedures will place new rows
 * in the correct org without any per-procedure modification, because
 * `resolveOrganizationId` (in @repo/api) reads from `effectiveWriteOrgId`
 * with higher priority than both explicit-null input and session. See the
 * security comment in `resolveOrganizationId` for why that ordering is safe.
 */
export function grantProjectAccess(
	projectId: string,
	organizationId: string | null = null,
): void {
	const ctx = tenantStorage.getStore();
	if (!ctx) {
		return;
	}
	if (!ctx.allowedProjectIds.includes(projectId)) {
		ctx.allowedProjectIds.push(projectId);
	}
	// Elevate the write org id when the granted project belongs to an org.
	// Conflicts are a loud error: if a single request attempts to grant
	// access to projects in two different orgs, we'd have no principled way
	// to pick the write target, so fail loudly instead of silently dropping
	// data into the wrong org. Same-org re-grants are idempotent.
	if (organizationId) {
		if (
			ctx.effectiveWriteOrgId &&
			ctx.effectiveWriteOrgId !== organizationId
		) {
			throw new Error(
				`Request attempted to grant access to projects in multiple organizations (${ctx.effectiveWriteOrgId} → ${organizationId}). One request should target a single project's organization.`,
			);
		}
		ctx.effectiveWriteOrgId = organizationId;
	}
}

/**
 * Create a tenant context from session data.
 * Convenience function for use in middleware.
 */
export function createTenantContextFromSession(session: {
	userId: string;
	activeOrganizationId?: string | null;
}): TenantContext {
	if (session.activeOrganizationId) {
		return createOrganizationContext(
			session.activeOrganizationId,
			session.userId,
		);
	}
	return createPersonalContext(session.userId);
}

// ============================================================================
// SQL Context Helpers (for RLS)
// ============================================================================

/**
 * Generate SQL statements to set the tenant context for RLS.
 * These should be executed at the start of each database connection/transaction.
 */
export function getTenantContextSQL(): string[] {
	const ctx = getTenantContext();

	if (ctx.type === "none" || !ctx.tenantId) {
		// No tenant context - set to safe defaults that will block all access
		return [
			"SET LOCAL app.tenant_type = 'none'",
			"SET LOCAL app.tenant_id = ''",
			"SET LOCAL app.user_id = ''",
		];
	}

	return [
		`SET LOCAL app.tenant_type = '${ctx.type}'`,
		`SET LOCAL app.tenant_id = '${ctx.tenantId}'`,
		`SET LOCAL app.user_id = '${ctx.userId ?? ""}'`,
	];
}

/**
 * Get tenant context as parameters for raw SQL queries.
 */
export function getTenantContextParams(): {
	tenantType: string;
	tenantId: string;
	userId: string;
} {
	const ctx = getTenantContext();
	return {
		tenantType: ctx.type,
		tenantId: ctx.tenantId ?? "",
		userId: ctx.userId ?? "",
	};
}
