import { ORPCError } from "@orpc/server";
import {
	readWorkspaceDocumentContent,
	WorkspaceDocumentContentError,
	workspaceDocumentContentInputSchema,
	workspaceDocumentContentPageSchema,
} from "@repo/database/prisma/queries/workspaces/document-content";
import { z } from "zod";
import {
	Permissions,
	requireInputOrgPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";

export const readDocumentContentProcedure = tenantProtectedProcedure
	.use(
		requireInputOrgPermission(Permissions.WORKSPACE_READ, {
			requireOrganization: true,
		}),
	)
	.route({
		method: "GET",
		path: "/document-workspaces/{workspaceId}/documents/{documentId}/content",
		tags: ["Document Workspaces"],
		summary: "Read a bounded revision-pinned document page",
	})
	.input(
		workspaceDocumentContentInputSchema.extend({
			organizationId: z.string().nullable().optional(),
		}),
	)
	.output(workspaceDocumentContentPageSchema)
	.handler(async ({ input, context }) => {
		context.resHeaders?.set("Cache-Control", "private, no-store");
		const { organizationId: namedOrganizationId, ...page } = input;
		const organizationId = resolveOrganizationId(
			namedOrganizationId,
			context.session,
		);
		try {
			return await readWorkspaceDocumentContent(
				{
					userId: context.user.id,
					organizationId: organizationId ?? "",
				},
				page,
			);
		} catch (error) {
			if (error instanceof WorkspaceDocumentContentError) {
				throw new ORPCError(
					error.status === 404
						? "NOT_FOUND"
						: error.status === 403
							? "FORBIDDEN"
							: error.status === 409
								? "CONFLICT"
								: "BAD_REQUEST",
					{ message: error.message, data: { reason: error.code } },
				);
			}
			throw new ORPCError("INTERNAL_SERVER_ERROR", {
				message: "Workspace document content could not be read.",
			});
		}
	});
