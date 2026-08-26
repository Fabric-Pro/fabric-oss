import { ORPCError } from "@orpc/client";
import {
	getDocumentById,
	hasProjectAccess,
	restoreDocumentVersion,
} from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";

export const restoreVersionProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.DOCUMENT_UPDATE))
	.route({
		method: "POST",
		path: "/projects/:projectId/documents/:documentId/versions/:versionNumber/restore",
		tags: ["Projects", "Documents", "Versions"],
		summary: "Restore document version",
		description: "Restore a document to a previous version",
	})
	.input(
		z.object({
			projectId: z.string(),
			documentId: z.string(),
			versionNumber: z.number().int().positive(),
			organizationId: z.string().nullable().optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const user = context.user;
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		// Check project access
		const hasAccess = await hasProjectAccess(
			input.projectId,
			user.id,
			organizationId,
		);

		if (!hasAccess) {
			throw new ORPCError("FORBIDDEN", {
				message: "You don't have access to this project",
			});
		}

		// Verify document belongs to project
		const document = await getDocumentById(input.documentId);

		if (!document || document.projectId !== input.projectId) {
			throw new ORPCError("NOT_FOUND", {
				message: "Document not found",
			});
		}

		// Restore version
		// TENANT ISOLATION: Pass tenant context for proper tenant filtering
		const restoredDocument = await restoreDocumentVersion(
			input.documentId,
			input.versionNumber,
			user.id,
			{
				userId: user.id,
				organizationId,
			},
		);

		return { document: restoredDocument };
	});
