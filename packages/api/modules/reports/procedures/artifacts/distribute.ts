import { ORPCError } from "@orpc/server";
import {
	distributeReportArtifact,
	ReportDistributionError,
	reportDistributionSchema,
} from "@repo/database/prisma/queries/report-distribution";
import { z } from "zod";
import {
	Permissions,
	requireInputOrgPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
export const distributeReportArtifactProcedure = tenantProtectedProcedure
	.use(
		requireInputOrgPermission(Permissions.REPORT_SHARE, {
			requireOrganization: true,
		}),
	)
	.input(
		reportDistributionSchema.extend({
			organizationId: z.string().optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);
		if (!organizationId) {
			throw new ORPCError("FORBIDDEN");
		}
		try {
			const { organizationId: _, ...request } = input;
			return await distributeReportArtifact(
				{ userId: context.user.id, organizationId },
				request,
			);
		} catch (error) {
			if (error instanceof ReportDistributionError) {
				throw new ORPCError(error.code, { message: error.message });
			}
			throw error;
		}
	});
