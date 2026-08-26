import { ORPCError } from "@orpc/client";
import {
	type AuditLogRow,
	hasProjectAccess,
	listDecisionOverrideAuditRows,
} from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";

/**
 * Read a string field from an audit row's metadata bag. Prisma types the
 * `metadata` column as `unknown`, so we narrow defensively and fall back to an
 * empty string rather than trust the shape.
 */
function metaString(metadata: Record<string, unknown>, key: string): string {
	const value = metadata[key];
	return typeof value === "string" ? value : "";
}

/**
 * Shape one immutable `decision.override_accepted` row into the fields the
 * read-only Overrides list renders: when, who, which decision, the accepted
 * surface, and the nature of the conflict.
 */
function shapeOverrideRow(row: AuditLogRow) {
	const metadata =
		row.metadata &&
		typeof row.metadata === "object" &&
		!Array.isArray(row.metadata)
			? (row.metadata as Record<string, unknown>)
			: {};
	return {
		id: row.id,
		createdAt: row.createdAt,
		actorName: row.actorNameSnapshot,
		actorEmail: row.actorEmailSnapshot,
		decisionId: row.resourceId,
		decisionIdentifier:
			metaString(metadata, "decisionIdentifier") ||
			row.resourceName ||
			"",
		decisionTitle: metaString(metadata, "decisionTitle"),
		surface: metaString(metadata, "surface"),
		artifactType: metaString(metadata, "artifactType"),
		natureOfConflict: metaString(metadata, "natureOfConflict"),
		conflictType: metaString(metadata, "conflictType"),
	};
}

/**
 * Read-only admin view of accepted decision pre-check overrides for a project.
 * Surfaces the immutable `decision.override_accepted` WORM rows (one per
 * conflicting decision) written when a reviewer accepts AI output that
 * contradicts a logged architecture decision. No mutation surface — this only
 * reads the audit ledger, scoped by project + XOR tenant isolation.
 *
 * ADMIN-ONLY: the override ledger is an audit surface, so it is gated on
 * `PROJECT_SETTINGS_EDIT` (project ADMIN + OWNER) rather than the read
 * permission viewers/editors inherit — mirroring how the org audit log is gated
 * on `ORG_AUDIT_LOG_READ`.
 */
export const listDecisionOverridesProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_SETTINGS_EDIT))
	.route({
		method: "GET",
		path: "/projects/{projectId}/decision-overrides",
		tags: ["Projects", "Architecture Decisions"],
		summary: "List accepted decision pre-check overrides for a project",
	})
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);
		const canAccess = await hasProjectAccess(
			input.projectId,
			context.user.id,
			organizationId,
		);
		if (!canAccess) {
			throw new ORPCError("FORBIDDEN", {
				message: "You don't have access to this project",
			});
		}

		const rows = await listDecisionOverrideAuditRows({
			scope: {
				organizationId: organizationId ?? null,
				userId: context.user.id,
			},
			projectId: input.projectId,
		});
		return { overrides: rows.map(shapeOverrideRow) };
	});
