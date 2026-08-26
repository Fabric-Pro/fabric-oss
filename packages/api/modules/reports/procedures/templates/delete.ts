import { ORPCError } from "@orpc/server";
import { deleteReportTemplate, getReportTemplate } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireOrganizationMembership,
	requirePermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";

const deleteInputSchema = z.object({
	id: z.string(),
});

export const deleteTemplateProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.REPORT_DELETE))
	.input(deleteInputSchema)
	.handler(async ({ input, context }) => {
		const organizationId = resolveOrganizationId(
			undefined,
			context.session,
		);

		// First get the template to check ownership
		const existing = await getReportTemplate({
			id: input.id,
			userId: context.user.id,
			organizationId,
		});

		if (!existing) {
			throw new ORPCError("NOT_FOUND", {
				message: "Report template not found",
			});
		}

		// Check ownership
		if (existing.scope === "USER" && existing.userId !== context.user.id) {
			throw new ORPCError("FORBIDDEN", {
				message: "You can only delete your own templates",
			});
		}

		if (existing.scope === "ORGANIZATION" && existing.organizationId) {
			await requireOrganizationMembership(
				existing.organizationId,
				context.user.id,
				["admin", "owner"],
			);
		}

		if (existing.scope === "SYSTEM") {
			throw new ORPCError("FORBIDDEN", {
				message: "System templates cannot be deleted",
			});
		}

		await deleteReportTemplate(input.id);

		return { success: true };
	});
