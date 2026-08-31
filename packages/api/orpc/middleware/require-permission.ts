/**
 * Permission-enforcement middleware.
 *
 * - `requirePermission(key)` — checks the caller's active organization role.
 *   Use for org-scoped procedures.
 *
 * - `requireProjectPermission(key)` — checks either:
 *     (a) the caller's org role (if the project belongs to their active org), or
 *     (b) the caller's ProjectMember row (guest path; populated by the guest
 *         invite flow in Phase 4).
 *   Use for procedures whose input includes a `projectId`.
 *
 * Both factories tag the returned middleware with a symbol so the coverage
 * test can assert every procedure declares a permission.
 */

import { ORPCError, os } from "@orpc/server";
import {
	db,
	getOrganizationMembership,
	getTenantContext,
	grantProjectAccess,
} from "@repo/database";
import {
	hasPermission,
	type Permission,
	resolveOrgPermissions,
} from "@repo/permissions";
import { runWithProjectContext } from "@repo/utils/project-context";
import { resolveEffectiveProjectPermissions } from "../../lib/effective-project-permissions";

/**
 * When RBAC_DRY_RUN=true, permission denials are logged as warnings
 * instead of throwing FORBIDDEN. This allows a safe observation period
 * after deploy to catch false positives before enforcing.
 *
 * Real-production hard-fail: dry-run turns every permission denial into
 * a console.warn — a stale-session or misconfigured role bypass becomes
 * a live data leak. Refuse to start with dry-run enabled on the real
 * production project.
 *
 * Keyed off FABRIC_ENV (explicit, set per Vercel project) rather than
 * NODE_ENV, because Vercel runs every deployment — including staging —
 * with NODE_ENV=production. VERCEL_ENV is ANDed in so a preview
 * deployment on the prod project still allows dry-run.
 */
if (
	process.env.RBAC_DRY_RUN === "true" &&
	process.env.FABRIC_ENV === "production" &&
	process.env.VERCEL_ENV === "production"
) {
	throw new Error(
		"RBAC_DRY_RUN=true is not permitted on the production project " +
			"(FABRIC_ENV=production, VERCEL_ENV=production). Dry-run downgrades " +
			"FORBIDDEN errors to warnings and is an observation-only mode for " +
			"non-production environments.",
	);
}

const RBAC_DRY_RUN = process.env.RBAC_DRY_RUN === "true";

function denyPermission(
	permission: string,
	message: string,
	userId?: string | null,
): void {
	if (RBAC_DRY_RUN) {
		console.warn(
			`[RBAC dry-run] userId=${userId ?? "unknown"} ${message} (permission: ${permission})`,
		);
		return;
	}
	throw new ORPCError("FORBIDDEN", { message });
}

/**
 * Symbol used by the coverage test to detect a permission declaration.
 */
export const PERMISSION_MIDDLEWARE_TAG = Symbol.for("fabric.permission");

type TaggedMiddleware = ReturnType<typeof os.middleware> & {
	[PERMISSION_MIDDLEWARE_TAG]?: Permission;
};

type PermissionContext = {
	activeOrganizationRole: string | null;
	allowedProjectIds: string[];
	/**
	 * Populated only on procedures that chain `tenantContextMiddleware`
	 * (i.e. `tenantProtectedProcedure`). Procedures built on plain
	 * `protectedProcedure` leave this undefined, and we treat that as
	 * personal-context equivalent below — the procedure author opted out
	 * of tenant isolation, so there is no org role to evaluate.
	 */
	tenantContext?: {
		userId: string | null;
		type: "organization" | "personal" | "none";
		organizationId: string | null;
	};
};

/**
 * Require a permission from the caller's active organization role.
 *
 * In personal context (no organization) the check is skipped — personal
 * data is already scoped to the caller's userId by tenant-db, so there
 * is no org role to evaluate. This prevents false FORBIDDEN errors for
 * users operating on their own resources without an active organization.
 */
export function requirePermission(permission: Permission) {
	const mw = os
		.$context<PermissionContext>()
		.middleware(async ({ context, next }) => {
			// Personal context (or procedures without tenantContextMiddleware):
			// data isolation is handled by tenant-db/userId filters and there
			// is no org role to evaluate — skip the permission check.
			if (
				!context.tenantContext ||
				context.tenantContext.type === "personal"
			) {
				return next();
			}

			const granted = resolveOrgPermissions(
				context.activeOrganizationRole,
			);
			if (!hasPermission(granted, permission)) {
				denyPermission(
					permission,
					`Missing required permission: ${permission}`,
					context.tenantContext.userId,
				);
			}
			return next();
		}) as TaggedMiddleware;
	mw[PERMISSION_MIDDLEWARE_TAG] = permission;
	return mw;
}

/**
 * Require a permission on a specific project. The procedure input must include
 * a `projectId: string` field.
 *
 * Resolution order:
 *  A. Personal-project owner — project has no org and `project.userId` matches
 *     the caller.
 *  B. An **active** `ProjectMember` row (accepted, non-expired) is
 *     authoritative for this project. Its role alone determines access —
 *     even org admins are restricted by an active Viewer row. Pending or
 *     expired rows fall through to path C.
 *  C. Fallback: the caller is an OrgMember of the project's host org AND
 *     that org role grants the permission. Covers org members with no
 *     explicit ProjectMember row.
 *  D. Otherwise, FORBIDDEN.
 */
/**
 * The project-permission decision, extracted from the middleware around it.
 *
 * Kept separate because it is the shape a HANDLER needs. Twelve weave
 * procedures identify their work by a `planId`, so the project is only known
 * after the plan is loaded and no middleware can see it; the check for those
 * has to happen where the plan does. This is what they would call, and keeping
 * one implementation is what stops the two answering differently.
 *
 * What it means for a guest was measured before it was wired, because it is not
 * obvious: NO project role grants `AGENT_CREATE`, `AGENT_UPDATE` or
 * `AGENT_DELETE`. The project ladder tops out at `AGENT_EXECUTE`, because agent
 * management is an organization-level concern. So a project-scoped guest can
 * read weave plans and start executions, and cannot approve, revise or delete
 * one — their ProjectMember row is authoritative and cannot grant what those
 * ask for. That is the ruling, not an accident of the tables.
 *
 * The precedence is project-authoritative: an owner passes, an active
 * ProjectMember row decides alone, and the organization role is the fallback.
 * Throws rather than returning a boolean — every caller's answer to "no" is to
 * stop, and a boolean invites one of them to carry on.
 */
export async function assertProjectPermission(
	projectId: string,
	userId: string,
	permission: Permission,
	context?: { allowedProjectIds?: string[] },
): Promise<void> {
	const access = await resolveEffectiveProjectPermissions(projectId, userId);
	if (!access) {
		throw new ORPCError("NOT_FOUND", { message: "Project not found" });
	}

	// A personal-project owner passes unconditionally, matching the middleware
	// exactly — an owner is authorized for any project permission, including
	// ones outside the OWNER permission set.
	if (access.source === "owner") {
		return;
	}

	if (hasPermission(access.permissions, permission)) {
		// An active ProjectMember grant seeds the tenant carve-out so
		// downstream tenant-db reads can see this project for a guest. An
		// org-role grant needs no carve-out — the organization filter covers it.
		if (access.source === "project-member") {
			grantProjectAccess(projectId, access.organizationId);
			if (context) {
				context.allowedProjectIds = [
					...(context.allowedProjectIds ?? []),
					projectId,
				];
			}
		}
		return;
	}

	denyPermission(
		permission,
		`Missing required permission: ${permission}`,
		userId,
	);
}

export function requireProjectPermission(
	permission: Permission,
	options?: { projectIdKey?: string },
) {
	const key = options?.projectIdKey ?? "projectId";
	const mw = os
		.$context<PermissionContext & { user?: { id: string } }>()
		.middleware(async ({ context, next }, input: unknown) => {
			const projectId = (input as Record<string, unknown> | undefined)?.[
				key
			] as string | undefined;
			if (!projectId) {
				throw new ORPCError("BAD_REQUEST", {
					message: `${key} is required for project-scoped procedures`,
				});
			}

			// Read-only mode: set the ambient project context for
			// the whole downstream chain (handler + any in-process external
			// dispatch it makes) so the write-gate resolves the owning project
			// with no per-call-site threading. Covers every procedure that USES
			// this middleware — a project-scoped procedure on org-level
			// requirePermission gets no ambient context and must thread
			// projectId to the gate explicitly (post-ship review finding).
			return runWithProjectContext(projectId, async () => {
				const userId =
					context.tenantContext?.userId ?? context.user?.id ?? null;
				if (!userId) {
					throw new ORPCError("UNAUTHORIZED");
				}

				// One implementation, shared with the handler-side check the
				// plan-scoped procedures use — two copies of this precedence
				// would eventually answer differently.
				await assertProjectPermission(
					projectId,
					userId,
					permission,
					context,
				);
				return next();
			});
		}) as TaggedMiddleware;
	mw[PERMISSION_MIDDLEWARE_TAG] = permission;
	return mw;
}

/**
 * Require a permission from the caller's active organization role,
 * OR — if the caller has at least one accepted `ProjectMember` row on a
 * project belonging to the resolved organization context — treat them as
 * a project-scoped guest and allow. This is the middleware list-like
 * procedures use when they can be called from either full org members
 * OR guests whose only tie to the org is a ProjectMember row.
 *
 * The procedure handler is still responsible for scoping its result set
 * (e.g. `listProjects` filters to projects the user can access). This
 * middleware only answers "is the caller allowed to call this at all".
 *
 * The resolved organization is read from two places in this order:
 *  1. `input.organizationId` (string or explicit null for personal)
 *  2. `context.session.activeOrganizationId` (may be null)
 *
 * When in personal context (no organization), the middleware passes
 * through — personal data is already scoped to the caller's userId
 * by tenant-db.
 */
export function requirePermissionAllowGuest(permission: Permission) {
	const mw = os
		.$context<
			PermissionContext & {
				user: { id: string };
				session: { activeOrganizationId?: string | null };
			}
		>()
		.middleware(async ({ context, next }, input: unknown) => {
			// Personal context (or procedures without tenantContextMiddleware):
			// data isolation is handled by tenant-db/userId filters and there
			// is no org role to evaluate — skip the permission check.
			if (
				!context.tenantContext ||
				context.tenantContext.type === "personal"
			) {
				return next();
			}

			// Path A: full org role grants the permission.
			const granted = resolveOrgPermissions(
				context.activeOrganizationRole,
			);
			if (hasPermission(granted, permission)) {
				return next();
			}

			// Path B: project-scoped guest. Resolve the target org from
			// explicit input or session, then look for any accepted
			// ProjectMember row on a project in that org.
			//
			// NOTE: session.activeOrganizationId is used here only as a
			// routing hint to narrow the DB query — it is NOT an
			// authorization signal. The actual grant decision comes from
			// the projectMember row lookup below.
			const explicit = (
				input as { organizationId?: string | null } | undefined
			)?.organizationId;
			const resolvedOrg =
				explicit === undefined
					? (context.session.activeOrganizationId ?? null)
					: explicit;
			if (resolvedOrg) {
				const guestRow = await db.projectMember.findFirst({
					where: {
						userId: context.user.id,
						acceptedAt: { not: null },
						OR: [
							{ expiresAt: null },
							{ expiresAt: { gt: new Date() } },
						],
						project: { organizationId: resolvedOrg },
					},
					select: { id: true },
				});
				if (guestRow) {
					return next();
				}
			}

			denyPermission(
				permission,
				`Missing required permission: ${permission}`,
				context.user.id,
			);
			return next();
		}) as TaggedMiddleware;
	mw[PERMISSION_MIDDLEWARE_TAG] = permission;
	return mw;
}

/**
 * Local mirror of `resolveOrganizationId` (packages/api/orpc/procedures.ts).
 *
 * Duplicated rather than imported to avoid a `require-permission` ↔
 * `procedures` import cycle — `procedures.ts` imports the permission
 * middleware from THIS file. It uses `getTenantContext()` so the guest-write
 * path (`effectiveWriteOrgId`) resolves identically to what the handler will
 * compute. **Keep this in sync with `resolveOrganizationId`.**
 */
function resolveTargetOrganizationId(
	inputOrganizationId: string | null | undefined,
	session: { activeOrganizationId?: string | null },
): string | undefined {
	if (inputOrganizationId) {
		return inputOrganizationId;
	}
	const ctx = getTenantContext();
	if (ctx.effectiveWriteOrgId) {
		return ctx.effectiveWriteOrgId;
	}
	if (inputOrganizationId === null) {
		return undefined;
	}
	if (session.activeOrganizationId) {
		return session.activeOrganizationId;
	}
	return undefined;
}

/**
 * Require a permission evaluated against the **input-resolved organization**,
 * not merely the caller's session organization.
 *
 * WHY THIS EXISTS (SOC 2 CC6.1 / CC6.3). `requirePermission` only checks the
 * caller's *session* org role (`context.activeOrganizationRole`, populated by
 * `tenantContextMiddleware` from `session.activeOrganizationId`). Handlers that
 * act on an org taken from `input.organizationId` (via `resolveOrganizationId`)
 * were therefore authorizing against the wrong tenant: an admin of org A could
 * pass `organizationId: <org B>` and mutate org B, because their org-A role
 * satisfied `requirePermission`. This middleware closes that gap: it resolves
 * the SAME target org the handler will use and verifies the caller is a member
 * of THAT org with a role that grants `permission`.
 *
 * Behaviour:
 *  - **Nothing resolved** (`undefined` / explicit `null`): pass through, exactly
 *    like `requirePermission` — this was personal context, whose data is scoped
 *    to the caller's `userId` by tenant-db, so there was no org role to check.
 *    Pass `requireOrganization: true` to REFUSE instead, which is required on
 *    any procedure that no longer has a personal variant — otherwise sending
 *    `organizationId: null` skips the role check.
 *  - **Org context**: look up the caller's membership in the *resolved* org.
 *    No membership → `FORBIDDEN` (a hard cross-tenant boundary, never
 *    downgraded by `RBAC_DRY_RUN`). Member but role lacks `permission` →
 *    `denyPermission` (respects `RBAC_DRY_RUN`, same as `requirePermission`).
 *
 * Drop-in replacement for `requirePermission` on org-scoped procedures whose
 * input carries `organizationId` (override the field name via
 * `options.orgIdKey`). Do NOT use on project-scoped procedures — those use
 * `requireProjectPermission`, which is already object-level.
 */
export function requireInputOrgPermission(
	permission: Permission,
	options?: { orgIdKey?: string; requireOrganization?: boolean },
) {
	const key = options?.orgIdKey ?? "organizationId";
	const mw = os
		.$context<
			PermissionContext & {
				user?: { id: string };
				session: { activeOrganizationId?: string | null };
			}
		>()
		.middleware(async ({ context, next }, input: unknown) => {
			const inputOrgId = (input as Record<string, unknown> | undefined)?.[
				key
			] as string | null | undefined;

			const organizationId = resolveTargetOrganizationId(
				inputOrgId,
				context.session,
			);

			// Nothing resolved. Historically that meant personal context, where
			// no org role applies because tenant-db scopes by userId — so the
			// check passed through.
			//
			// That pass-through is a BYPASS for a procedure that has no personal
			// variant: `organizationId: null` in the input resolves to nothing
			// (explicit null deliberately does not fall back to the session), so
			// a caller who sends it skips the role check entirely. The handler
			// still refuses a non-member — object-level access is checked
			// against the row's real organization — but the ROLE never runs,
			// which is exactly what this middleware exists to make it do.
			//
			// `requireOrganization` closes that on procedures where personal
			// context no longer exists. It is opt-in rather than the default
			// because the pass-through is still correct for the account-global
			// procedures that share this middleware.
			if (!organizationId) {
				if (options?.requireOrganization) {
					throw new ORPCError("FORBIDDEN", {
						message:
							"This operation requires an organization context",
					});
				}
				return next();
			}

			const userId =
				context.tenantContext?.userId ?? context.user?.id ?? null;
			if (!userId) {
				throw new ORPCError("UNAUTHORIZED");
			}

			// Membership in the TARGET org is a hard tenant boundary — a
			// non-member acting on this org is always a cross-tenant violation,
			// so this is never downgraded by RBAC_DRY_RUN.
			const membership = await getOrganizationMembership(
				organizationId,
				userId,
			);
			if (!membership) {
				throw new ORPCError("FORBIDDEN", {
					message: "You are not a member of this organization",
				});
			}

			// Role-level permission check mirrors requirePermission, but against
			// the resolved org's role (not the session org's).
			const granted = resolveOrgPermissions(membership.role);
			if (!hasPermission(granted, permission)) {
				denyPermission(
					permission,
					`Missing required permission: ${permission}`,
					userId,
				);
			}
			return next();
		}) as TaggedMiddleware;
	mw[PERMISSION_MIDDLEWARE_TAG] = permission;
	return mw;
}

/**
 * Runtime helper: is this middleware a tagged permission middleware?
 * Used by the coverage test.
 */
export function getPermissionFromMiddleware(
	mw: unknown,
): Permission | undefined {
	if (mw && typeof mw === "object") {
		return (mw as TaggedMiddleware)[PERMISSION_MIDDLEWARE_TAG];
	}
	return undefined;
}
