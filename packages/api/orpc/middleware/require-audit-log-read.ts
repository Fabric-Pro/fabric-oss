/**
 * Audit-log permission middleware.
 *
 * Two factories — `requireAuditLogReadOrDeploymentAdmin()` and
 * `requireAuditLogExportOrDeploymentAdmin()` — share the same
 * `isDeploymentAdmin` helper so the bypass behaviour cannot drift
 * between read and export.
 *
 * Behaviour (per spec §5.3, D3):
 *
 *   - Personal-context calls (`input.organizationId === null` or omitted)
 *     pass through unconditionally. The procedure handler scopes the
 *     query to the caller's own user id, so personal events are
 *     user-owned by construction.
 *   - Org-context calls (`input.organizationId` is a string) require
 *     EITHER:
 *       * the caller is in `FABRIC_DEPLOYMENT_ADMIN_EMAILS` (any case,
 *         comma-separated, whitespace-trimmed) — the bypass ALSO waives
 *         the tenant-membership check, so a Fabric SRE can query any
 *         org on a deployed instance without being added as a member, OR
 *       * the caller has an active `member` row in the target org AND
 *         that role's grants include the audit-log permission. This
 *         resolves to `owner`/`admin` per `packages/permissions/lib/roles.ts`
 *         (granted via `ADMIN_ORG_PERMISSIONS` which `OWNER_ORG_PERMISSIONS`
 *         spreads).
 *
 * The env var is read on every invocation rather than cached so operators
 * can update it at runtime by setting a new value and the next request
 * picks it up.
 *
 * IMPORTANT: The audit-log procedures in this module deliberately use
 * `protectedProcedure` (NOT `tenantProtectedProcedure`) so the deployment
 * admin's request is not rejected by the tenant-membership check inside
 * `tenantContextMiddleware` before this middleware can run. Because of
 * that, `context.activeOrganizationRole` is NOT populated for us by an
 * upstream middleware — we look up membership directly via
 * `db.member.findUnique` against `input.organizationId`.
 *
 * Spec: docs/audit-log/README.md §5.3
 * (Risk #1).
 */

import { ORPCError, os } from "@orpc/server";
import { db } from "@repo/database";
import {
	hasPermission,
	type Permission,
	Permissions,
	resolveOrgPermissions,
} from "@repo/permissions";
import { PERMISSION_MIDDLEWARE_TAG } from "./require-permission";

/**
 * Read the env list of deployment-admin emails and decide whether the
 * given email matches. Case-insensitive, comma-separated, whitespace
 * trimmed, empty entries skipped.
 *
 * Exported so the same parsing rules can be re-applied in the layout
 * (server-side, to decide whether to render the sidebar entry).
 */
export function isDeploymentAdmin(email: string | null | undefined): boolean {
	if (!email || typeof email !== "string") {
		return false;
	}
	const raw = process.env.FABRIC_DEPLOYMENT_ADMIN_EMAILS ?? "";
	if (!raw.trim()) {
		return false;
	}

	const normalized = email.trim().toLowerCase();
	if (!normalized) {
		return false;
	}

	const entries = raw
		.split(",")
		.map((entry) => entry.trim().toLowerCase())
		.filter((entry) => entry.length > 0);

	return entries.includes(normalized);
}

type AuditMiddlewareContext = {
	user: { id: string; email: string };
};

type AuditMiddlewareInput = {
	organizationId?: string | null;
};

type TaggedMiddleware = ReturnType<typeof os.middleware> & {
	[PERMISSION_MIDDLEWARE_TAG]?: Permission;
};

/**
 * Build the middleware. Returns the inner factory that the audit
 * procedures chain after `.input(...)` so we can read the resolved
 * `organizationId` off the validated input.
 */
function buildAuditPermissionMiddleware(permission: Permission) {
	const mw = os
		.$context<AuditMiddlewareContext>()
		.middleware(async ({ context, next }, input: unknown) => {
			const inputOrgId =
				(input as AuditMiddlewareInput | undefined)?.organizationId ??
				null;

			// Personal-context shortcut. Procedures handle data scoping
			// in their handler.
			if (!inputOrgId) {
				return next();
			}

			// Env-list deployment admin bypass — also waives membership.
			if (isDeploymentAdmin(context.user?.email ?? null)) {
				return next();
			}

			// Membership-based grant. The audit procedures opt out of
			// `tenantContextMiddleware`, so look up the role directly.
			const member = await db.member.findUnique({
				where: {
					organizationId_userId: {
						organizationId: inputOrgId,
						userId: context.user.id,
					},
				},
				select: { role: true },
			});
			if (!member) {
				throw new ORPCError("FORBIDDEN", {
					message: "You are not a member of this organization",
				});
			}

			const granted = resolveOrgPermissions(member.role);
			if (hasPermission(granted, permission)) {
				return next();
			}

			throw new ORPCError("FORBIDDEN", {
				message: `Missing required permission: ${permission}`,
			});
		}) as TaggedMiddleware;
	mw[PERMISSION_MIDDLEWARE_TAG] = permission;
	return mw;
}

/**
 * Authorize an `audit.list` call. Composes `ORG_AUDIT_LOG_READ` with the
 * env-list bypass and the personal-context pass-through.
 */
export function requireAuditLogReadOrDeploymentAdmin() {
	return buildAuditPermissionMiddleware(Permissions.ORG_AUDIT_LOG_READ);
}

/**
 * Authorize an `audit.export` call. Composes `ORG_AUDIT_LOG_EXPORT` with
 * the env-list bypass and the personal-context pass-through.
 */
export function requireAuditLogExportOrDeploymentAdmin() {
	return buildAuditPermissionMiddleware(Permissions.ORG_AUDIT_LOG_EXPORT);
}
