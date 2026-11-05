import { ORPCError } from "@orpc/server";
import {
	canAccessReportInstance,
	deleteTemplateInstance,
	getTemplateInstance,
} from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireInputOrgPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import {
	assertCanEditReportInstance,
	assertReportPermission,
} from "../../lib/report-access";

const deleteInstanceInputSchema = z.object({
	id: z.string(),
	organizationId: z.string().nullable().optional(),
});

export const deleteInstanceProcedure = tenantProtectedProcedure
	.use(requireInputOrgPermission(Permissions.REPORT_READ))
	.input(deleteInstanceInputSchema)
	.handler(async ({ input, context }) => {
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);
		await assertReportPermission(
			organizationId,
			context.user,
			Permissions.REPORT_DELETE,
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

		await assertCanEditReportInstance(existing, context.user);

		if (
			!(await canAccessReportInstance(
				existing,
				{ userId: context.user.id, organizationId },
				undefined,
				true,
			))
		) {
			throw new ORPCError("FORBIDDEN", {
				message: "Project report write access denied",
			});
		}

		await deleteTemplateInstance(input.id);

		return {
			success: true,
			message: "Template instance deleted",
		};
	});
