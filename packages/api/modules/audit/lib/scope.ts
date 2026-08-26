/**
 * Tenant-scope resolution for the audit-log procedures.
 *
 * Membership + permission gating happens in the
 * `requireAuditLogReadOrDeploymentAdmin` middleware
 * (`packages/api/orpc/middleware/require-audit-log-read.ts`). This helper
 * is called AFTER the middleware authorizes the request and is purely
 * concerned with shaping the `AuditLogScope` that the query helpers
 * consume.
 *
 * Spec: docs/audit-log/README.md §5.3,
 * §6.1.
 */

import type { AuditLogScope } from "@repo/database";

export interface AuditScopeContext {
	user: { id: string; email: string };
}

/**
 * Resolve the tenant scope for an `audit.list` or `audit.export` call.
 *
 *   - `input.organizationId === null` or `undefined` -> personal scope.
 *     The query is constrained to the caller's own user id so a user
 *     never sees another user's personal events.
 *   - `input.organizationId` is a string -> org scope. The user filter
 *     is unset because every member can see the org-wide trail (per D14:
 *     personal events are XOR-isolated; org events are visible to admins
 *     by virtue of the permission gate the middleware enforces).
 */
export function resolveAuditLogScope(
	context: AuditScopeContext,
	inputOrganizationId: string | null | undefined,
): AuditLogScope {
	if (
		inputOrganizationId === null ||
		typeof inputOrganizationId === "undefined"
	) {
		return {
			organizationId: null,
			userId: context.user.id,
		};
	}
	return {
		organizationId: inputOrganizationId,
		userId: null,
	};
}
