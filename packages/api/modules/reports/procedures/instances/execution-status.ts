import { ORPCError } from "@orpc/server";
import { reportConnectionDiagnosticsSchema } from "@repo/database/prisma/queries/lib/report-public-diagnostics";
import { z } from "zod";
import {
	Permissions,
	requireInputOrgPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { runReportCommand } from "../../lib/report-commands";
export const reportExecutionStatusSchema = z.object({
	executionId: z.string(),
	instanceId: z.string(),
	status: z.string(),
	startedAt: z.string().nullable(),
	completedAt: z.string().nullable(),
	duration: z.number().nullable(),
	mcpDiagnostics: reportConnectionDiagnosticsSchema,
	error: z.string().nullable(),
	artifacts: z.array(
		z.object({
			id: z.string(),
			name: z.string(),
			artifactType: z.string(),
			mimeType: z.string(),
			size: z.number().nullable(),
			createdAt: z.string(),
			artifactHash: z.string().nullable(),
			linkedFrameId: z.string().nullable(),
		}),
	),
});
export const getReportExecutionStatusProcedure = tenantProtectedProcedure
	.use(
		requireInputOrgPermission(Permissions.REPORT_READ, {
			requireOrganization: true,
		}),
	)
	.input(
		z.object({
			executionId: z.string().min(1),
			organizationId: z.string().optional(),
		}),
	)
	.output(reportExecutionStatusSchema)
	.handler(async ({ input, context }) => {
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);
		if (!organizationId) {
			throw new ORPCError("FORBIDDEN");
		}
		return reportExecutionStatusSchema.parse(
			await runReportCommand(
				{ userId: context.user.id, organizationId, scopes: ["*"] },
				"status",
				{ executionId: input.executionId },
			),
		);
	});
