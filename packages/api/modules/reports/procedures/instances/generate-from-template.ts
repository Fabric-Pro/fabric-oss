import { ORPCError } from "@orpc/server";
import { isFeatureEnabled } from "@repo/database";
import { z } from "zod";
import {
	assertProjectPermission,
	enforceAiRateLimit,
	enforceWorkflowRateLimit,
	Permissions,
	requireInputOrgPermission,
	requireOrganizationMembership,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import {
	canCreateProjectReport,
	mayUseReportPermission,
} from "../../lib/report-access";
import { generateReportFromTemplate } from "../../lib/report-one-click";
import { ReportGenerationError } from "../../lib/report-refusal";

const generateFromTemplateInputSchema = z.object({
	templateId: z.string().min(1),
	projectId: z.string().min(1).max(128),
	organizationId: z.string().nullable().optional(),
});

/**
 * "Generate report" on a template card. Adding the report and starting its run
 * are the same two gates `instances.create` and `instances.execute` hold, and
 * the project is authorized before the organization resolves to its own.
 */
export const generateFromTemplateProcedure = tenantProtectedProcedure
	.use(
		requireInputOrgPermission(Permissions.REPORT_READ, {
			requireOrganization: true,
		}),
	)
	.input(generateFromTemplateInputSchema)
	.handler(async ({ input, context, path }) => {
		await assertProjectPermission(
			input.projectId,
			context.user.id,
			Permissions.REPORT_READ,
		);
		if (!(await canCreateProjectReport(input.projectId, context.user))) {
			throw new ORPCError("FORBIDDEN", {
				message:
					"You need at least the Editor role on this project to add a report",
			});
		}
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);
		if (!organizationId) {
			throw new ORPCError("BAD_REQUEST", {
				message: "An organization is required",
			});
		}
		await requireOrganizationMembership(organizationId, context.user.id);
		if (
			!(await mayUseReportPermission(
				organizationId,
				context.user,
				Permissions.REPORT_CREATE,
			))
		) {
			throw new ORPCError("FORBIDDEN", {
				message: "Your organization role cannot add reports",
			});
		}
		if (
			!(await mayUseReportPermission(
				organizationId,
				context.user,
				Permissions.REPORT_EXECUTE,
			))
		) {
			throw new ORPCError("FORBIDDEN", {
				message: "Your organization role cannot generate reports",
			});
		}
		if (!(await isFeatureEnabled("REPORT_SUITE_V2", organizationId))) {
			throw new ORPCError("FORBIDDEN", {
				message:
					"One-click generation is not available in this organization",
			});
		}

		try {
			return await generateReportFromTemplate({
				caller: context.user,
				organizationId,
				projectId: input.projectId,
				templateId: input.templateId,
				enforceRateLimit: () =>
					enforceAiRateLimit(context.user.id, path),
				enforceRunRateLimit: () =>
					enforceWorkflowRateLimit(context.user.id, path),
			});
		} catch (error) {
			if (error instanceof ReportGenerationError) {
				throw new ORPCError(error.code, { message: error.message });
			}
			throw error;
		}
	});
