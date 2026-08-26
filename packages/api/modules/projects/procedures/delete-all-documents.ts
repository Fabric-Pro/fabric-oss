import { ORPCError } from "@orpc/client";
import { hasProjectAccess } from "@repo/database";
import { db } from "@repo/database/prisma/client";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";

/**
 * Delete all documents for a project.
 * Also cascades delete of versions.
 */
export const deleteAllDocumentsProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_DELETE))
	.route({
		method: "DELETE",
		path: "/projects/:projectId/documents",
		tags: ["Projects", "Documents"],
		summary: "Delete all project documents",
		description: "Delete all documents and their versions for a project",
	})
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const user = context.user;
		const { projectId } = input;
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		// Check project access
		const hasAccess = await hasProjectAccess(
			projectId,
			user.id,
			organizationId,
		);
		if (!hasAccess) {
			throw new ORPCError("FORBIDDEN", {
				message: "You don't have access to this project",
			});
		}

		// Find all document ids
		const docs = await db.projectDocument.findMany({
			where: { projectId },
			select: { id: true },
		});
		const ids = docs.map((d) => d.id);

		if (ids.length === 0) {
			return { success: true, deleted: 0 };
		}

		// Delete versions first (safety if cascade not configured)
		await db.documentVersion.deleteMany({
			where: { documentId: { in: ids } },
		});

		// Delete documents
		const res = await db.projectDocument.deleteMany({
			where: { id: { in: ids } },
		});

		return { success: true, deleted: res.count };
	});
