/**
 * Delete Approval Template Procedure
 *
 * Deletes an approval template.
 */

import { deleteApprovalTemplate } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireInputOrgPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";

const inputSchema = z.object({
	id: z.string(),
	organizationId: z.string().nullable().optional(),
});

const outputSchema = z.object({
	success: z.boolean(),
	error: z.string().optional(),
});

export const deleteApprovalTemplateProcedure = tenantProtectedProcedure
	.use(requireInputOrgPermission(Permissions.WORKSPACE_DELETE))
	.route({
		method: "DELETE",
		path: "/approval-templates/{id}",
		tags: ["Orchestrator"],
		summary: "Delete approval template",
		description: "Delete an approval template",
	})
	.input(inputSchema)
	.output(outputSchema)
	.handler(async ({ input, context }) => {
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		const success = await deleteApprovalTemplate(input.id, {
			userId: context.user.id,
			organizationId: organizationId ?? undefined,
		});

		if (!success) {
			return {
				success: false,
				error: "Template not found or you don't have permission to delete it",
			};
		}

		return {
			success: true,
		};
	});
