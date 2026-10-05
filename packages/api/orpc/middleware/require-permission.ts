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
	resolveProjectPermissions,
} from "@repo/permissions";
import { runWithProjectContext } from "@repo/utils/project-context";
import {
	type AuthorizedProject,
	assertProjectBindable,
	recordAuthorizedProject,
	resolveBoundOrganization,
} from "../../lib/authorized-project-binding";
import { DELETED_ORGANIZATION_ERROR_CODE } from "../../lib/deleted-organization";
import { resolveEffectiveProjectPermissions } from "../../lib/effective-project-permissions";
import { MISSING_ORGANIZATION_CONTEXT_ERROR_CODE } from "../../lib/missing-organization-context";
import { PROJECT_NOT_FOUND_MESSAGE } from "./project-visibility";

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
 * Resolution order. The paths are NAMED, not lettered, and deliberately so:
 * this list and the implementation in `../../lib/effective-project-permissions.ts`
 * used to letter the same three paths differently — the org fallback was "C"
 * here and "B" there, while "C" there meant the ProjectMember path, the
 * opposite rule. Two people discussing "path C" were discussing two different
 * rules depending on which file they had last read, and it cost real time
 * diagnosing Fizzy #2615. Cite a path by what it does.
 *
 *  1. PERSONAL-PROJECT OWNER — the project has no organization and
 *     `project.userId` matches the caller.
 *  2. ACTIVE PROJECT MEMBER — an accepted, non-expired `ProjectMember` row is
 *     authoritative for this project. Its role alone determines access —
 *     even org admins are restricted by an active Viewer row. A pending or
 *     expired row falls through to the org fallback.
 *  3. ORG-ROLE FALLBACK — the caller is an OrgMember of the project's host org
 *     AND that org role grants the permission. Covers org members with no
 *     explicit `ProjectMember` row.
 *
 *     IT IS ALSO THE BOOTSTRAP, which is easy to miss and expensive to forget:
 *     `createProject` writes NO `ProjectMember` row, and the only two places
 *     that ever create one are invitation acceptance. A freshly created
 *     organization project therefore has zero member rows, path 1 cannot fire
 *     for it, and path 2 has nothing to match — so this path is the only way
 *     ANY caller, including the project's own creator, passes this gate on a
 *     new organization project. Remove it and every organization project is
 *     inert from birth: nobody can reach `PROJECT_MEMBERS_MANAGE` to create
 *     the first member row.
 *  4. Otherwise, NOT_FOUND — in the same words as an id that names no
 *     project. A caller none of the three paths tie to the project must not
 *     learn that it exists (Fizzy #2639). FORBIDDEN is reserved for a caller
 *     one of the paths DOES tie to the project whose role lacks the permission.
 *
 * THIS GATE IS WIDER THAN `buildProjectAccessWhere`, ON PURPOSE. That predicate
 * (`@repo/database`, behind `getProjectById` and `hasProjectAccess`) has no
 * org-role path. The two answer different questions — this one "may you act",
 * that one "may you discover" — and
 * `packages/api/__tests__/project-scoped-lookup-ownership-ratchet.test.ts`
 * exists to stop anyone collapsing them.
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
 *
 * On success it RETURNS the authorized project and its organization, and records
 * the same value in the request's authorized-project binding
 * (`../../lib/authorized-project-binding.ts`), on every path — owner, active
 * ProjectMember and organization role alike. The organization resolvers then
 * refuse a different input organization and default to this one, which is what
 * stops a caller pairing a project they can reach with an organization they
 * cannot. A handler that authorizes a project and then needs its organization
 * should use the return value rather than re-reading the store. Outside an oRPC
 * call there is no binding holder and only the return value carries it.
 *
 * Refusals, in order — existence-hiding stays first:
 *  1. NOT_FOUND for a missing project and for a caller no path ties to it.
 *  2. FORBIDDEN with `DELETED_ORGANIZATION_ERROR_CODE` when the project's
 *     organization is soft-deleted — the same answer the tenant middleware
 *     gives for a deleted workspace, which it could not give here because it
 *     only checks the SESSION's organization.
 *  3. BAD_REQUEST when this request already authorized a project in a
 *     different organization — checked before any side effect of this
 *     authorization, so the guest carve-out is never half-applied.
 *  4. FORBIDDEN (or the dry-run warning) when the role lacks `permission`.
 *
 * A project with no organization (the owner path) is recorded with
 * `organizationId: null` and NOT refused here: a procedure that never consumes
 * an organization keeps working. The resolvers refuse it when one is consumed.
 */
export async function assertProjectPermission(
	projectId: string,
	userId: string,
	permission: Permission,
	context?: { allowedProjectIds?: string[] },
): Promise<AuthorizedProject> {
	const access = await resolveEffectiveProjectPermissions(projectId, userId);
	if (!access) {
		throw new ORPCError("NOT_FOUND", {
			message: PROJECT_NOT_FOUND_MESSAGE,
		});
	}

	// EXISTENCE BEFORE PERMISSION. A caller with no tie to the project at all
	// — not its owner, no active ProjectMember row, not a member of its host
	// organization — is answered exactly as an id that names no project is.
	// Answering FORBIDDEN here instead told anyone who could authenticate
	// which project ids exist in organizations they have no part in (Fizzy
	// #2639). Only a caller the resolver ties to the project is allowed to
	// hear FORBIDDEN, and such a caller already knows it exists.
	//
	// Deliberately not routed through `denyPermission`: RBAC_DRY_RUN downgrades
	// a permission denial to a warning, but this is not a permission decision
	// and must never be downgraded.
	if (access.source === "none") {
		throw new ORPCError("NOT_FOUND", {
			message: PROJECT_NOT_FOUND_MESSAGE,
		});
	}

	// The project's organization is in its deletion retention window. The
	// caller is tied to the project (the check above passed), so saying so
	// discloses nothing; serving it would let a project-scoped call keep
	// running AI and writing rows inside an organization nobody can open.
	// Never downgraded by RBAC_DRY_RUN — this is not a permission decision.
	if (access.organizationDeleted) {
		throw new ORPCError("FORBIDDEN", {
			message: "This organization has been deleted",
			data: { errorCode: DELETED_ORGANIZATION_ERROR_CODE },
		});
	}

	const authorized: AuthorizedProject = Object.freeze({
		projectId,
		organizationId: access.organizationId,
	});

	// Before any side effect: a request that already authorized a project in a
	// different organization is refused here, with a typed error, rather than by
	// the plain `Error` `grantProjectAccess` would throw after mutating.
	assertProjectBindable(authorized);

	// A personal-project owner passes unconditionally, matching the middleware
	// exactly — an owner is authorized for any project permission, including
	// ones outside the OWNER permission set.
	if (access.source === "owner") {
		recordAuthorizedProject(authorized);
		return authorized;
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
		recordAuthorizedProject(authorized);
		return authorized;
	}

	denyPermission(
		permission,
		`Missing required permission: ${permission}`,
		userId,
	);
	// Reached only under RBAC_DRY_RUN, where the denial above was downgraded to
	// a warning and the request carries on as if granted. It carries on in the
	// project's organization, not one the caller named.
	recordAuthorizedProject(authorized);
	return authorized;
}

/**
 * BAD_REQUEST when the input names a non-null organization other than the
 * authorized project's — the same refusal, in the same words, as the
 * resolvers (`resolveBoundOrganization`) and `assertInputOrgMatchesProject`.
 * A non-string value is left to the input schema.
 */
function assertInputOrgMatchesAuthorizedProject(
	inputOrganizationId: unknown,
	authorized: AuthorizedProject,
): void {
	if (
		typeof inputOrganizationId === "string" &&
		inputOrganizationId.length > 0 &&
		inputOrganizationId !== authorized.organizationId
	) {
		throw new ORPCError("BAD_REQUEST", {
			message: "organizationId does not match the project",
		});
	}
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
				const authorized = await assertProjectPermission(
					projectId,
					userId,
					permission,
					context,
				);
				// Refuse a caller-named organization that is not the authorized
				// project's HERE, before the handler body runs. The resolvers
				// refuse it too, but a handler that writes, deletes or
				// dispatches before it resolves would otherwise leave that
				// work committed behind a failed response. Not a permission
				// decision, so never downgraded by RBAC_DRY_RUN. `null` and
				// `undefined` pass: the resolvers default them to the
				// project's organization.
				assertInputOrgMatchesAuthorizedProject(
					(input as Record<string, unknown> | undefined)
						?.organizationId,
					authorized,
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
 * compute. **Keep this in sync with `resolveOrganizationId`.** The
 * authorized-project rule is shared rather than copied
 * (`resolveBoundOrganization`), so the two cannot disagree on it: once a
 * project is authorized, the organization checked here is that project's.
 */
function resolveTargetOrganizationId(
	inputOrganizationId: string | null | undefined,
	session: { activeOrganizationId?: string | null },
): string | undefined {
	const bound = resolveBoundOrganization(inputOrganizationId);
	if (bound.bound) {
		return bound.organizationId;
	}
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
 * The check `requireInputOrgPermission` runs, callable from a handler that
 * reaches an organization-scoped read or write on only some of its paths (a
 * provider-specific branch of a shared procedure, say). Same resolution, same
 * refusals and the same machine-readable missing-organization cause as the
 * middleware — the middleware calls this — so a handler gets the one rule
 * instead of a copy of it.
 *
 * Returns the resolved organization id, or undefined when nothing resolved
 * and `requireOrganization` is not set (personal context, passed through).
 */
export async function authorizeInputOrganization(
	permission: Permission,
	inputOrgId: string | null | undefined,
	context: Pick<PermissionContext, "tenantContext"> & {
		user?: { id: string };
		session: { activeOrganizationId?: string | null };
	},
	options?: { requireOrganization?: boolean },
): Promise<string | undefined> {
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
			// The middleware's own emission of this refusal. It carries
			// the same machine-readable cause as the prompt module's
			// gate (`modules/prompts/lib/assert-organization-context.ts`,
			// which the deletion and its impact read share) so a client
			// recognises every one of them the same way. Safe to act on
			// because this runs before the handler: nothing has
			// happened yet.
			throw new ORPCError("FORBIDDEN", {
				message: "This operation requires an organization context",
				data: {
					errorCode: MISSING_ORGANIZATION_CONTEXT_ERROR_CODE,
				},
			});
		}
		return undefined;
	}

	const userId = context.tenantContext?.userId ?? context.user?.id ?? null;
	if (!userId) {
		throw new ORPCError("UNAUTHORIZED");
	}

	// Membership in the TARGET org is a hard tenant boundary — a
	// non-member acting on this org is always a cross-tenant violation,
	// so this is never downgraded by RBAC_DRY_RUN.
	const membership = await getOrganizationMembership(organizationId, userId);
	if (!membership) {
		throw new ORPCError("FORBIDDEN", {
			message: "You are not a member of this organization",
		});
	}

	// A soft-deleted TARGET organization is refused, as the tenant middleware
	// refuses a deleted session organization — which it is not, here: a member
	// of a live organization can name a deleted one they still belong to and
	// would otherwise reach its providers and tools during the retention
	// window. After the membership check, so a non-member learns nothing about
	// the organization; read from the membership row's organization, so no
	// second query. Not a permission decision: never downgraded by
	// RBAC_DRY_RUN.
	if (membership.organization?.deletedAt) {
		throw new ORPCError("FORBIDDEN", {
			message: "This organization has been deleted",
			data: { errorCode: DELETED_ORGANIZATION_ERROR_CODE },
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
	return organizationId;
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
			await authorizeInputOrganization(
				permission,
				inputOrgId,
				context,
				options,
			);
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

/**
 * In-handler permission check for a project, using the same resolution
 * order as `requireProjectPermission` (personal owner → active ProjectMember
 * row → org role). Use when a procedure needs a *second*, finer permission on
 * one code path only (e.g. `PROJECT_GOVERNANCE_MANAGE` to clear existing
 * stories under a GOVERNED profile) without gating the whole procedure.
 *
 * Fails closed: any lookup error or missing project yields `false`.
 */
export async function userHasProjectPermission(params: {
	userId: string;
	projectId: string;
	permission: Permission;
}): Promise<boolean> {
	const { userId, projectId, permission } = params;
	try {
		const project = await db.project.findUnique({
			where: { id: projectId },
			select: { id: true, organizationId: true, userId: true },
		});
		if (!project) {
			return false;
		}
		if (project.userId === userId && project.organizationId === null) {
			return true;
		}
		const member = await db.projectMember.findUnique({
			where: { projectId_userId: { projectId, userId } },
			select: { role: true, acceptedAt: true, expiresAt: true },
		});
		const memberActive =
			member !== null &&
			member.acceptedAt !== null &&
			(member.expiresAt === null || member.expiresAt > new Date());
		if (memberActive) {
			return hasPermission(
				resolveProjectPermissions(member.role),
				permission,
			);
		}
		if (project.organizationId) {
			const orgMember = await db.member.findFirst({
				where: { organizationId: project.organizationId, userId },
				select: { role: true },
			});
			if (orgMember) {
				return hasPermission(
					resolveOrgPermissions(orgMember.role),
					permission,
				);
			}
		}
		return false;
	} catch {
		return false;
	}
}
