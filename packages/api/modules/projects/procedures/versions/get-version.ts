import { ORPCError } from "@orpc/client";
import {
	getDocumentById,
	getDocumentVersion,
	hasProjectAccess,
} from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";

export const getVersionProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.DOCUMENT_READ))
	.route({
		method: "GET",
		path: "/projects/:projectId/documents/:documentId/versions/:versionNumber",
		tags: ["Projects", "Documents", "Versions"],
		summary: "Get document version",
		description: "Get a specific version of a document",
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

		// Get version
		const version = await getDocumentVersion(
			input.documentId,
			input.versionNumber,
		);

		if (!version) {
			throw new ORPCError("NOT_FOUND", {
				message: "Version not found",
			});
		}

		return { version };
	});
