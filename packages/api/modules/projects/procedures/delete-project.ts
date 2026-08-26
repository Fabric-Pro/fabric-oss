import { db, softDeleteProject } from "@repo/database";
import { z } from "zod";
import { recordAuditFromRequest } from "../../../lib/audit";
import {
	Permissions,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";

/**
 * Soft delete a project
 *
 * AUTHORIZATION: Only the project OWNER can delete a project.
 * - Personal projects: User must be the owner
 * - Org projects: User must be org member AND project owner
 *
 * Note: Editors and viewers cannot delete projects, only the owner can.
 *
 * The project will be:
 * - Marked as deleted (deletedAt set)
 * - Hidden from normal listings
 * - Available in "Deleted" view for 7 days
 * - Automatically permanently deleted after 7 days via scheduled workflow
 */
export const deleteProjectProcedure = tenantProtectedProcedure
	.use(
		requireProjectPermission(Permissions.PROJECT_DELETE, {
			projectIdKey: "id",
		}),
	)
	.route({
		method: "DELETE",
		path: "/projects/:id",
		tags: ["Projects"],
		summary: "Soft delete project",
		description:
			"Soft delete a project. The project will be preserved for 7 days and can be restored. Only the project owner can delete.",
	})
	.input(
		z.object({
			id: z.string(),
			organizationId: z.string().nullable().optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const user = context.user;
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		// Authorization is enforced by `requireProjectPermission` above.
		// PROJECT_DELETE is granted only to OWNER (see
		// `packages/permissions/lib/roles.ts`), so this is owner-only.

		// Snapshot the project name BEFORE the delete so the audit row carries
		// a `resourceName` even after the project is purged (D11, spec §7.4).
		// Soft-delete here means the row survives, but we keep the snapshot
		// path uniform with hard-delete callers in tests.
		const snapshot = await db.project.findFirst({
			where: { id: input.id, deletedAt: null },
			select: { name: true },
		});

		// Soft delete the project (sets deletedAt and schedules permanent deletion)
		// No Qdrant deletion yet - that happens during permanent delete
		await softDeleteProject(input.id, user.id, organizationId);

		// Audit-log emission. Fire-and-forget; the snapshot above
		// guarantees `resourceName` even if the cascade purges the row later.
		recordAuditFromRequest(context, {
			action: "project.deleted",
			category: "project",
			organizationId,
			projectId: input.id,
			resource: {
				type: "project",
				id: input.id,
				name: snapshot?.name ?? null,
			},
			metadata: {
				softDeleted: true,
			},
		});

		return { success: true, softDeleted: true };
	});
