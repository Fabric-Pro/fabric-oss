import { ORPCError } from "@orpc/client";
import { hasProjectAccess, listDocuments } from "@repo/database";
import {
	ProjectDocumentStatusSchema,
	ProjectDocumentTypeSchema,
} from "@repo/database/prisma/zod";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";

export const listDocumentsProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_READ))
	.route({
		method: "GET",
		path: "/projects/:projectId/documents",
		tags: ["Projects", "Documents"],
		summary: "List documents",
		description: "List documents for a project",
	})
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
			type: ProjectDocumentTypeSchema.optional(),
			status: ProjectDocumentStatusSchema.optional(),
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

		// List documents
		const result = await listDocuments({
			projectId: input.projectId,
			type: input.type,
			status: input.status,
		});

		// Return the full result object with documents array, total, and hasMore
		return result;
	});
