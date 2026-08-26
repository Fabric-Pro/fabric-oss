import { ORPCError } from "@orpc/server";
import { deleteTemplateInstance, getTemplateInstance } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireInputOrgPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";

const deleteInstanceInputSchema = z.object({
	id: z.string(),
	organizationId: z.string().nullable().optional(),
});

export const deleteInstanceProcedure = tenantProtectedProcedure
	.use(requireInputOrgPermission(Permissions.REPORT_DELETE))
	.input(deleteInstanceInputSchema)
	.handler(async ({ input, context }) => {
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		// Verify instance exists and user has access
		const existing = await getTemplateInstance({
			id: input.id,
			userId: context.user.id,
			organizationId,
		});

		if (!existing) {
			throw new ORPCError("NOT_FOUND", {
				message: "Template instance not found or access denied",
			});
		}

		await deleteTemplateInstance(input.id);

		return {
			success: true,
			message: "Template instance deleted",
		};
	});
