import { ORPCError } from "@orpc/server";
import {
	getReportTemplate,
	isFeatureEnabled,
	resolveReportTemplateDefaults,
} from "@repo/database";
import { z } from "zod";
import {
	assertProjectPermission,
	enforceAiRateLimit,
	Permissions,
	requireInputOrgPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { canCreateProjectReport } from "../../lib/report-access";
import { startingReportParameters } from "../../lib/report-creation";
import { suggestReportParameters } from "../../lib/report-parameter-suggestions";
import { isOrganizationOwnedTemplate } from "../../lib/template-prompts";

const parameterDefaultsInputSchema = z.object({
	templateId: z.string().min(1),
	projectId: z.string().min(1).max(128),
	organizationId: z.string().nullable().optional(),
});

/**
 * What the create dialog fills on arrival, for someone who may add reports to
 * the project: the values a new report starts with (`values`, and the
 * organization's and project's default `context` and `prompts`), and AI's
 * suggestions for the parameters those leave empty (`suggested`, rate-limited,
 * empty on any failure).
 */
export const templateParameterDefaultsProcedure = tenantProtectedProcedure
	.use(
		requireInputOrgPermission(Permissions.REPORT_READ, {
			requireOrganization: true,
		}),
	)
	.input(parameterDefaultsInputSchema)
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
		if (!(await isFeatureEnabled("REPORT_SUITE_V2", organizationId))) {
			throw new ORPCError("FORBIDDEN", {
				message:
					"Parameter defaults are not available in this organization",
			});
		}
		const template = await getReportTemplate({
			id: input.templateId,
			userId: context.user.id,
			organizationId,
		});
		if (!template) {
			throw new ORPCError("NOT_FOUND", {
				message: "Report template not found or access denied",
			});
		}
		const overrides = await resolveReportTemplateDefaults({
			templateId: template.id,
			organizationId,
			projectId: input.projectId,
		});
		const values = await startingReportParameters({
			templateParameters: template.parameters,
			organizationId,
			projectId: input.projectId,
			overrideValues: overrides.parameterDefaults,
		});
		const suggested = await suggestReportParameters({
			template,
			filled: values,
			projectId: input.projectId,
			caller: context.user,
			organizationId,
			enforceRateLimit: () => enforceAiRateLimit(context.user.id, path),
		});
		return {
			values,
			suggested,
			context: overrides.context,
			// What `createReportFromTemplate` will copy onto the report.
			prompts:
				(isOrganizationOwnedTemplate(template, organizationId)
					? overrides.projectPrompts
					: overrides.prompts) ?? null,
		};
	});
