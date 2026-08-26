import { ORPCError } from "@orpc/server";
import { getReportTemplate } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireInputOrgPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";

const getInputSchema = z.object({
	id: z.string(),
	organizationId: z.string().nullable().optional(),
});

export const getTemplateProcedure = tenantProtectedProcedure
	.use(requireInputOrgPermission(Permissions.REPORT_READ))
	.input(getInputSchema)
	.handler(async ({ input, context }) => {
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		const template = await getReportTemplate({
			id: input.id,
			userId: context.user.id,
			organizationId,
		});

		if (!template) {
			throw new ORPCError("NOT_FOUND", {
				message: "Report template not found or access denied",
			});
		}

		return template;
	});
