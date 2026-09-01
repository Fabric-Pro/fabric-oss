import { ORPCError } from "@orpc/client";
import {
	adoptDocumentIntoProjectTenant,
	getDocumentById,
	hasProjectAccess,
} from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";

export const getDocumentProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_READ))
	.route({
		method: "GET",
		path: "/projects/:projectId/documents/:id",
		tags: ["Projects", "Documents"],
		summary: "Get document",
		description: "Get a document by ID",
	})
	.input(
		z.object({
			projectId: z.string(),
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

		// Get document
		const document = await getDocumentById(input.id);

		if (!document || document.projectId !== input.projectId) {
			throw new ORPCError("NOT_FOUND", {
				message: "Document not found",
			});
		}

		// Opening a document is where a tenant-less one gets adopted into its
		// project's organization. Project access is already established above, and
		// this read is the first thing every surface does with a document — so the
		// row is repaired at the moment someone needs it to work, rather than
		// waiting on a migration. See `adoptDocumentIntoProjectTenant`.
		const organizationIdAfterAdoption =
			await adoptDocumentIntoProjectTenant(document);

		return {
			document: {
				...document,
				organizationId: organizationIdAfterAdoption,
			},
		};
	});
