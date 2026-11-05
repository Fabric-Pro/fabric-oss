import { ORPCError } from "@orpc/server";
import {
	getReportTemplate,
	isFeatureEnabled,
	updateReportTemplate,
} from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireInputOrgPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import {
	assertCanManageReportTemplate,
	assertReportPermission,
} from "../../lib/report-access";
import {
	reportTemplateParameterDefaultsSchema,
	reportTemplatePromptsSchema,
	unknownReportAiTaskKeys,
	unknownReportParameterKeys,
	withReportTemplateParameterDefaults,
	withReportTemplatePrompts,
	withReportTemplateSystemPrompt,
} from "../../lib/template-prompts";

const saveTemplatePromptInputSchema = reportTemplatePromptsSchema.extend({
	// The report's organization, so an open page never acts on whichever
	// organization the session has moved to since.
	organizationId: z.string().min(1).max(128).optional(),
	templateId: z.string().min(1).max(128),
	// Values for the template's parameters, which become their defaults.
	parameterDefaults: reportTemplateParameterDefaultsSchema.optional(),
});

/**
 * Save a report's edited configuration to its template: the report
 * instructions, AI task prompts, system prompt and parameter values become the template's
 * own, as a new template version. Whoever may change the template may do this
 * (SYSTEM: platform admins, ORGANIZATION: the organization's admins and
 * owners, USER: the author). Reports already made from the template keep
 * their own values.
 */
export const saveTemplatePromptProcedure = tenantProtectedProcedure
	.use(requireInputOrgPermission(Permissions.REPORT_READ))
	.input(saveTemplatePromptInputSchema)
	.handler(async ({ input, context }) => {
		const hasParameterDefaults =
			Object.keys(input.parameterDefaults ?? {}).length > 0;
		if (
			input.userPrompt === undefined &&
			input.systemPrompt === undefined &&
			Object.keys(input.aiTasks ?? {}).length === 0 &&
			!hasParameterDefaults
		) {
			throw new ORPCError("BAD_REQUEST", {
				message:
					"Name the prompts or parameters to save to the template",
			});
		}
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);
		await assertReportPermission(
			organizationId,
			context.user,
			Permissions.REPORT_UPDATE,
		);
		if (!(await isFeatureEnabled("REPORT_SUITE_V2", organizationId))) {
			throw new ORPCError("FORBIDDEN", {
				message:
					"Saving to a template is not available in this organization",
			});
		}
		const template = await getReportTemplate({
			id: input.templateId,
			userId: context.user.id,
			organizationId,
		});
		if (!template) {
			throw new ORPCError("NOT_FOUND", {
				message: "Report template not found",
			});
		}
		await assertCanManageReportTemplate(template, context.user);
		if (template.archivedAt) {
			throw new ORPCError("BAD_REQUEST", {
				message: "This report template is archived",
			});
		}
		const unknownKeys = unknownReportAiTaskKeys(
			template.definition,
			input.aiTasks,
		);
		if (unknownKeys.length > 0) {
			throw new ORPCError("BAD_REQUEST", {
				message: `The template has no AI task named ${unknownKeys.join(", ")}`,
			});
		}
		const unknownParameters = unknownReportParameterKeys(
			template.parameters,
			input.parameterDefaults,
		);
		if (unknownParameters.length > 0) {
			throw new ORPCError("BAD_REQUEST", {
				message: `The template has no parameter named ${unknownParameters.join(", ")}`,
			});
		}

		const updated = await updateReportTemplate({
			id: template.id,
			// Written even when only parameters change: this bumps the version,
			// which also keeps a SYSTEM template's edit from the next seed.
			definition: withReportTemplatePrompts(template.definition, {
				userPrompt: input.userPrompt,
				aiTasks: input.aiTasks,
			}),
			...(input.systemPrompt !== undefined
				? {
						fabricConfig: withReportTemplateSystemPrompt(
							template.fabricConfig,
							input.systemPrompt,
						),
					}
				: {}),
			...(input.parameterDefaults && hasParameterDefaults
				? {
						parameters: withReportTemplateParameterDefaults(
							template.parameters,
							input.parameterDefaults,
						),
					}
				: {}),
		});
		return { id: updated.id, version: updated.version };
	});
