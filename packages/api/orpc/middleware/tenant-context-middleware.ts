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

import { ORPCError, os } from "@orpc/server";
import {
	createOrganizationContext,
	createPersonalContext,
	db,
	runWithTenantContext,
	type TenantContext,
} from "@repo/database";
import { logger } from "@repo/logs";
import type { OrgRole } from "@repo/permissions";
import { DELETED_ORGANIZATION_ERROR_CODE } from "../../lib/deleted-organization";
import { MISSING_ORGANIZATION_CONTEXT_ERROR_CODE } from "../../lib/missing-organization-context";
import { checkRateLimitSync } from "../../lib/rate-limit";

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
 * How long one session's missing-workspace record suppresses the next.
 *
 * This fires at request rate, so an open dashboard or a polling client would
 * otherwise emit hundreds of identical records and drown the signal. One
 * record per session per minute is enough to see that the session is broken.
 */
const MISSING_WORKSPACE_RECORD_WINDOW_MS = 60_000;

/** One record per session per window. */
const MISSING_WORKSPACE_RECORD_LIMIT = 1;

/**
 * Namespace for the dedup key.
 *
 * The window is enforced by `checkRateLimitSync`, whose in-memory store is
 * SHARED with every other caller of it, so a bare session id could collide with
 * some other feature's key for the same string. Prefixing by feature keeps this
 * counter its own.
 */
const MISSING_WORKSPACE_RECORD_KEY_PREFIX = "tenant-workspace-missing:session:";

/**
 * Record a request that resolved no workspace.
 *
 * This is the one point every such request crosses, so it is the only place
 * the condition is visible without instrumenting each procedure.
 *
 * The record carries three ids and NOTHING else: the acting user, the session
 * and the oRPC procedure path. No email, no name, no request URL or query
 * string, no input payload. It goes to the application log sink — not the
 * permission-gated audit table — where it is read by whoever can read server
 * logs, so it must stay free of anything that identifies a person or a
 * deployment beyond an opaque id.
 *
 * Never throws: a record about a request must not be able to break it.
 */
function recordRequestWithoutWorkspace(input: {
	userId: string;
	sessionId: string;
	path: readonly string[];
}): void {
	try {
		// "One per session per window" is a rate limit, so it uses the package's
		// rate limiter rather than a second hand-rolled Map: `checkRateLimitSync`
		// already owns the store, its expiry and its bounded growth, so this site
		// carries neither an unbounded map nor an O(n) sweep of its own.
		//
		// The SYNC variant is deliberate, and it is the only production caller of
		// it. The async `checkRateLimit` reaches Redis, which would make the
		// window fleet-wide instead of per-instance — but it also fails CLOSED
		// when Redis is unreachable in production, returning `allowed: false`.
		// That is right for a rate limiter and wrong for this: `allowed: false`
		// here means "do not record", so a Redis outage would silence the signal
		// that sessions are losing their workspace at exactly the moment the
		// deployment is already degraded. A suppressor for a diagnostic must fail
		// open where a limiter fails closed.
		//
		// The cost of that choice, stated so an operator is not misled: the window
		// is per process. N replicas can each emit one record per session per
		// window, so a burst of identical lines across pods is one broken session,
		// not N of them.
		const { allowed } = checkRateLimitSync(
			`${MISSING_WORKSPACE_RECORD_KEY_PREFIX}${input.sessionId}`,
			MISSING_WORKSPACE_RECORD_LIMIT,
			MISSING_WORKSPACE_RECORD_WINDOW_MS,
		);
		if (!allowed) {
			return;
		}

		logger.warn("tenant.workspace_missing", {
			userId: input.userId,
			sessionId: input.sessionId,
			procedurePath: input.path.join("."),
		});
	} catch {
		// Swallow — recording is best-effort and must never break the request.
	}
}

/**
 * Tenant context middleware for ORPC procedures.
 *
 * Sets up AsyncLocalStorage tenant context based on session's activeOrganizationId.
 * - If activeOrganizationId names a workspace the caller still holds a
 *   membership in: organization context
 * - If activeOrganizationId names a workspace the caller holds no membership
 *   in: the pointer is stale and the request is REFUSED with FORBIDDEN carrying
 *   `MISSING_ORGANIZATION_CONTEXT_ERROR_CODE`. It is recorded first, through the
 *   same channel a workspace-less request uses, so the condition stays visible
 *   on a path that ends in a throw
 * - If activeOrganizationId is null/undefined: no workspace resolved. Under
 *   `docs/adr/018-organization-is-the-only-tenant-context.md` every account has
 *   an organization, so this is a fail-closed default reached when something
 *   failed to resolve one — not a supported context. The request still runs;
 *   it is recorded so the condition is visible.
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
	.middleware(async ({ context, next, path }) => {
		const userId = context.user.id;
		const namedOrganizationId = context.session.activeOrganizationId;

		// The record both sites below emit, built once. They report the SAME
		// condition — no workspace resolved for this request — through the same
		// three ids, and two hand-built copies of one payload are two places a
		// field can be added, renamed or dropped in only one of them.
		const missingWorkspaceRecord = {
			userId,
			sessionId: context.session.id,
			path,
		};

		// Resolve the caller's role in the workspace the session names.
		// Better Auth stores membership in the `member` table.
		//
		// This lookup runs ONCE per request and its result answers two
		// questions: what the caller's role is, and — immediately below —
		// whether the pointer may be trusted at all. Do not add a second query
		// for the second question; it would double the query count of every
		// org-scoped request in the application.
		let activeOrganizationRole: OrgRole | null = null;
		let hasMembership = false;
		// Whether the workspace itself is still live. Deleting an organization
		// deactivates it for seven days before anything is destroyed
		// (Fizzy #2462), and THIS is where that deactivation is enforced: the
		// ~168 tables that cascade off `organization` carry no `deletedAt`
		// predicate of their own, and do not need one, because no request can
		// resolve a context for a deactivated workspace in the first place.
		// Selected through the membership lookup above rather than as a second
		// query — the third question this one lookup already answers.
		let organizationIsDeleted = false;
		if (namedOrganizationId) {
			const membership = await db.member.findUnique({
				where: {
					organizationId_userId: {
						organizationId: namedOrganizationId,
						userId,
					},
				},
				select: {
					role: true,
					organization: { select: { deletedAt: true } },
				},
			});
			hasMembership = membership !== null;
			activeOrganizationRole = (membership?.role ??
				null) as OrgRole | null;
			organizationIsDeleted = membership?.organization?.deletedAt != null;
		}

		// A WORKSPACE POINTER IS NOT A MEMBERSHIP. Resolution and session
		// insertion are not atomic: a sign-in can resolve a membership, have it
		// removed by a concurrent offboarding that clears only the sessions
		// existing at that moment, and then insert a session naming a workspace
		// the person has already left. Trust the pointer only while the
		// membership behind it still exists.
		//
		// Leaving the organization context standing was contained only by the
		// permission check failing on a null role, which is a property of each
		// procedure rather than of this boundary: tenant filtering still ran
		// against that organization id on every procedure without a permission
		// gate. (Fizzy #2403, R18.)
		//
		// A REJECTED POINTER IS REFUSED, NOT DOWNGRADED. Turning it into a
		// personal context reads as the fail-closed choice and is the opposite
		// one: `requirePermission` (./require-permission.ts) returns `next()`
		// without evaluating any role in personal context, so a caller the null
		// role used to deny became a caller nobody checked — a deny turned into
		// a pass-through. `resolveOrganizationId` (../procedures.ts) reads
		// `session.activeOrganizationId` directly rather than the tenant
		// context, so a handler could still resolve the left workspace and write
		// rows carrying it; RLS is no backstop, because the application role
		// bypasses it on the deployed host. A caller who explicitly named a
		// tenant they hold no membership in gets a refusal.
		if (namedOrganizationId && !hasMembership) {
			// Record BEFORE refusing. This is the same condition a
			// workspace-less request reports, and it must stay visible on the
			// path that ends in a throw.
			recordRequestWithoutWorkspace(missingWorkspaceRecord);
			// The same refusal the request's other workspace gates raise, so a
			// client recognises all of them the same way. Safe to act on: this
			// runs before any handler, so nothing has happened yet.
			throw new ORPCError("FORBIDDEN", {
				message: "This operation requires an organization context",
				data: { errorCode: MISSING_ORGANIZATION_CONTEXT_ERROR_CODE },
			});
		}

		// A DELETED WORKSPACE REFUSES EVERY REQUEST, INCLUDING ITS OWNER'S.
		// Checked after the membership gate so a non-member still learns nothing
		// about whether the workspace exists, and carries its own error code so
		// a client can offer the owner the way out — restoring it — instead of
		// the reload that answers a missing pointer. Deliberately not recorded
		// through `recordRequestWithoutWorkspace`: the workspace resolved
		// perfectly well, it is simply gone, and folding it into that signal
		// would make a normal consequence of deletion look like the session bug
		// that counter exists to measure.
		if (namedOrganizationId && organizationIsDeleted) {
			throw new ORPCError("FORBIDDEN", {
				message: "This organization has been deleted",
				data: { errorCode: DELETED_ORGANIZATION_ERROR_CODE },
			});
		}

		const organizationId = namedOrganizationId ?? null;

		// A session that names no workspace is a FAIL-CLOSED DEFAULT, not a
		// personal context: ADR-018 makes the organization the only tenant
		// context, so landing here means something failed to resolve one.
		// Record it — every workspace-less request crosses this point — through
		// the one channel, so the condition is visible in a single place rather
		// than two.
		if (!organizationId) {
			recordRequestWithoutWorkspace(missingWorkspaceRecord);
		}

		const tenantContext: TenantContext = organizationId
			? createOrganizationContext(organizationId, userId)
			: createPersonalContext(userId);

		// Defence in depth: the rest of the chain sees only the pointer this
		// middleware actually resolved. `resolveOrganizationId` reads
		// `session.activeOrganizationId` rather than the tenant context, so a
		// session left naming something this middleware did not resolve is the
		// route by which a rejected pointer could come back to life. In the
		// organization arm the pointer IS the resolved workspace, so the session
		// passes through untouched.
		//
		// The override is deliberately ABSENT FROM THE DECLARED OUTPUT TYPE.
		// The chain's session type comes from `protectedProcedure` and is the
		// full Better Auth session; this middleware is declared against a
		// three-field structural subset of it, so declaring `session` here would
		// narrow `context.session` for every downstream procedure. The runtime
		// value is the real session object with one field replaced, so the
		// inherited type stays accurate — only the compiler's knowledge of this
		// one substitution is dropped.
		const chainContext = {
			session: organizationId
				? context.session
				: { ...context.session, activeOrganizationId: null },
			tenantContext,
			activeOrganizationRole,
			allowedProjectIds: [] as string[],
		} as {
			tenantContext: TenantContext;
			activeOrganizationRole: OrgRole | null;
			allowedProjectIds: string[];
		};

		// Run the rest of the request chain within the tenant context
		return await runWithTenantContext(tenantContext, async () => {
			return await next({ context: chainContext });
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
