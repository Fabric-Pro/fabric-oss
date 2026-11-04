import { ORPCError } from "@orpc/server";
import {
	AIProviderNotConfiguredError,
	generateText,
	getAIModelWithMetadata,
	logModelUsageAsync,
} from "@repo/ai";
import {
	getBoundPromptForAgent,
	getReportTemplate,
	isFeatureEnabled,
} from "@repo/database";
import { logger } from "@repo/logs";
import { renderTemplate } from "@repo/utils";
import {
	REPORT_SAMPLE_FALLBACK_BODY,
	REPORT_SAMPLE_PROMPT_AGENT_KEY,
} from "@repo/utils/report-sample-prompt";
import { z } from "zod";
import { rethrowChatGptPlanRefusal } from "../../../../lib/chatgpt-plan-errors";
import {
	assertProjectPermission,
	enforceAiRateLimit,
	Permissions,
	requireInputOrgPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { canEditProjectReport } from "../../lib/report-access";

/** A sample is a short illustration; this bounds what one click can spend. */
const MAX_SAMPLE_OUTPUT_TOKENS = 1_500;

const sampleTemplateInputSchema = z.object({
	templateId: z.string().min(1),
	projectId: z.string().min(1).max(128),
	organizationId: z.string().nullable().optional(),
});

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}

/**
 * The prompt variables a template's stored JSON supplies: its name and
 * description, the section titles and data-source providers its definition
 * declares, and its own instructions for a real report.
 */
export function reportSampleVariables(template: {
	name: string;
	description: string | null;
	category: string | null;
	outputFormat: string;
	definition: unknown;
}): Record<string, string> {
	const definition = isRecord(template.definition) ? template.definition : {};
	const list = (key: string, field: string) =>
		(Array.isArray(definition[key]) ? definition[key] : [])
			.map((entry) => (isRecord(entry) ? text(entry[field]) : ""))
			.filter(Boolean);
	return {
		template_name: template.name.trim(),
		template_description: text(template.description),
		template_category: text(template.category),
		output_format: text(template.outputFormat),
		report_instructions: text(definition.userPrompt),
		section_titles: list("sections", "title").join(", "),
		data_sources: [...new Set(list("dataSources", "provider"))].join(", "),
	};
}

/**
 * An AI-written sample of what a template produces, for a template with no
 * successful report in the project yet. It runs only on an explicit request
 * from someone who may add reports to the project, is bounded in length, and
 * is returned to the screen alone: nothing is stored or sent.
 */
export const sampleTemplateProcedure = tenantProtectedProcedure
	.use(
		requireInputOrgPermission(Permissions.REPORT_CREATE, {
			requireOrganization: true,
		}),
	)
	.input(sampleTemplateInputSchema)
	.handler(async ({ input, context, path }) => {
		await assertProjectPermission(
			input.projectId,
			context.user.id,
			Permissions.REPORT_READ,
		);
		if (!(await canEditProjectReport(input.projectId, context.user))) {
			throw new ORPCError("FORBIDDEN", {
				message:
					"You need at least the Editor role on this project to preview a sample report",
			});
		}
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);
		if (
			!(await isFeatureEnabled(
				"REPORT_SUITE_V2",
				organizationId ?? undefined,
			))
		) {
			throw new ORPCError("FORBIDDEN", {
				message:
					"Sample reports are not available in this organization",
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
		// Every click is an AI call: cap it per user after the cheap refusals.
		await enforceAiRateLimit(context.user.id, path);

		try {
			const { model, metadata, trackUsage } =
				await getAIModelWithMetadata(
					{ taskType: "SIMPLE" },
					{
						userId: context.user.id,
						organizationId: organizationId ?? undefined,
					},
				);
			const boundPrompt = await getBoundPromptForAgent({
				agentName: REPORT_SAMPLE_PROMPT_AGENT_KEY,
				documentType: "GENERAL",
				storyKind: null,
				userId: context.user.id,
				organizationId: organizationId ?? undefined,
			});
			const rendered = await renderTemplate({
				format: boundPrompt?.format ?? "HANDLEBARS",
				template:
					boundPrompt?.version?.content ??
					REPORT_SAMPLE_FALLBACK_BODY,
				variables: reportSampleVariables(template),
				escape: false,
			});
			if (rendered.error) {
				logger.warn(
					"Report sample prompt render failed; using raw body",
					{
						templateId: template.id,
						error: rendered.error,
					},
				);
			}

			const startedAt = Date.now();
			const result = await generateText({
				model,
				prompt: rendered.rendered,
				maxOutputTokens: MAX_SAMPLE_OUTPUT_TOKENS,
			});
			trackUsage();
			logModelUsageAsync({
				context: {
					userId: context.user.id,
					organizationId: organizationId ?? undefined,
				},
				metadata,
				taskType: "SIMPLE",
				usage: result.usage,
				latencyMs: Date.now() - startedAt,
				projectId: input.projectId,
			});

			const content = result.text.trim();
			if (!content) {
				throw new ORPCError("INTERNAL_SERVER_ERROR", {
					message: "The sample came back empty. Try again.",
				});
			}
			return { content, generatedAt: new Date().toISOString() };
		} catch (error) {
			rethrowChatGptPlanRefusal(error);
			if (error instanceof ORPCError) {
				throw error;
			}
			if (error instanceof AIProviderNotConfiguredError) {
				throw new ORPCError("PRECONDITION_FAILED", {
					message:
						"No AI provider is configured for this workspace, so a sample can't be written.",
				});
			}
			logger.error("Report sample generation failed", {
				templateId: template.id,
				error,
			});
			throw new ORPCError("INTERNAL_SERVER_ERROR", {
				message: "The sample report could not be written. Try again.",
			});
		}
	});
