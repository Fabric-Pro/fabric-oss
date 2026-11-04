import { ORPCError } from "@orpc/server";
import { publicReportParametersSchema } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireInputOrgPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import {
	loadGeneratableReport,
	ReportGenerationError,
	startReportGeneration,
} from "../../lib/report-generation";

const executeInstanceInputSchema = z.object({
	instanceId: z.string(),
	organizationId: z.string().nullable().optional(),
	// Optional parameters to override instance defaults
	parameters: publicReportParametersSchema.optional(),
	idempotencyKey: z.string().uuid().optional(),
});

export const executeInstanceProcedure = tenantProtectedProcedure
	.use(
		requireInputOrgPermission(Permissions.REPORT_EXECUTE, {
			requireOrganization: true,
		}),
	)
	.input(executeInstanceInputSchema)
	.handler(async ({ input, context }) => {
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		if (!organizationId) {
			throw new ORPCError("BAD_REQUEST", {
				message: "An organization is required",
			});
		}

		try {
			const instance = await loadGeneratableReport(
				input.instanceId,
				context.user,
				organizationId,
			);
			return await startReportGeneration({
				instance,
				caller: context.user,
				organizationId,
				parameters: input.parameters,
				idempotencyKey: input.idempotencyKey,
				// A person clicked Generate and waits for the report.
				planEligible: true,
			});
		} catch (error) {
			if (error instanceof ReportGenerationError) {
				throw new ORPCError(error.code, { message: error.message });
			}
			throw error;
		}
	});
