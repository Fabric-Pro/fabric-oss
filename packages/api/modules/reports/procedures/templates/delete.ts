import { ORPCError } from "@orpc/server";
import { deleteReportTemplate, getReportTemplate } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { assertCanManageReportTemplate } from "../../lib/report-access";

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

		await assertCanManageReportTemplate(existing, context.user);

		await deleteReportTemplate(input.id);

		return { success: true };
	});
