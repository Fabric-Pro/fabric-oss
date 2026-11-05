import { createHash } from "node:crypto";
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
	getReportTemplateSample,
	isFeatureEnabled,
	saveReportTemplateSample,
} from "@repo/database";
import {
	genericSourceDataType,
	REPORT_DATA_TYPE_INFO,
} from "@repo/database/prisma/queries/lib/report-data-types";
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
	requireOrganizationMembership,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { canCreateProjectReport } from "../../lib/report-access";

/** A sample is a short illustration; this bounds what one click can spend. */
const MAX_SAMPLE_OUTPUT_TOKENS = 1_500;

const sampleTemplateInputSchema = z.object({
	templateId: z.string().min(1),
	// Needed only to write a new sample; a stored one is read from the template alone.
	projectId: z.string().min(1).max(128).optional(),
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
			.map((entry) => {
				const dataType = genericSourceDataType(entry);
				if (dataType) {
					return REPORT_DATA_TYPE_INFO[dataType].label;
				}
				return isRecord(entry) ? text(entry[field]) : "";
			})
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
 * The key a stored sample is found by: a hash of the exact prompt it was
 * written from. The prompt carries the template's variables and the sample
 * instructions the caller's organization binds, so a changed template or an
 * edited sample prompt writes a new sample, and a sample written from one
 * organization's own instructions is never shown under another's.
 */
export function reportSampleContentHash(prompt: string): string {
	return createHash("sha256").update(prompt).digest("hex");
}

/**
 * An AI-written sample of what a template produces, with invented data, for a
 * template that has no successful report to show yet. A stored sample written
 * from the same prompt is returned to anyone who may read the template (and
 * the project, when one is named), with no AI call. Otherwise one is written,
 * bounded in length and rate-limited per person. When its reader may add reports
 * to the project it is stored for everyone after them; anyone else sees it without
 * storing it. Nothing is sent anywhere.
 */
export const sampleTemplateProcedure = tenantProtectedProcedure
	.use(
		requireInputOrgPermission(Permissions.REPORT_READ, {
			requireOrganization: true,
		}),
	)
	.input(sampleTemplateInputSchema)
	.handler(async ({ input, context, path }) => {
		if (input.projectId) {
			await assertProjectPermission(
				input.projectId,
				context.user.id,
				Permissions.REPORT_READ,
			);
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
		// Naming a project resolves to the project's own organization, so a project
		// guest passes the checks above: a sample is the organization's to read.
		await requireOrganizationMembership(organizationId, context.user.id);
		if (!(await isFeatureEnabled("REPORT_SUITE_V2", organizationId))) {
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

		const boundPrompt = await getBoundPromptForAgent({
			agentName: REPORT_SAMPLE_PROMPT_AGENT_KEY,
			documentType: "GENERAL",
			storyKind: null,
			userId: context.user.id,
			organizationId: organizationId ?? undefined,
			projectId: input.projectId,
		});
		const rendered = await renderTemplate({
			format: boundPrompt?.format ?? "HANDLEBARS",
			template:
				boundPrompt?.version?.content ?? REPORT_SAMPLE_FALLBACK_BODY,
			variables: reportSampleVariables(template),
			escape: false,
		});
		if (rendered.error) {
			logger.warn("Report sample prompt render failed; using raw body", {
				templateId: template.id,
				error: rendered.error,
			});
		}
		const contentHash = reportSampleContentHash(rendered.rendered);

		const stored = await getReportTemplateSample({
			templateId: template.id,
			contentHash,
		});
		// `reused`: an earlier stored sample, returned without an AI call.
		if (stored) {
			return {
				content: stored.content,
				generatedAt: stored.generatedAt.toISOString(),
				reused: true,
			};
		}

		// Every new sample is an AI call: cap it per user after the cheap refusals.
		await enforceAiRateLimit(context.user.id, path);
		const mayStore =
			input.projectId !== undefined &&
			(await canCreateProjectReport(input.projectId, context.user));

		let content: string;
		try {
			const { model, metadata, trackUsage } =
				await getAIModelWithMetadata(
					{ taskType: "SIMPLE" },
					{
						userId: context.user.id,
						organizationId: organizationId ?? undefined,
					},
				);

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
			content = result.text.trim();
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
		if (!content) {
			throw new ORPCError("INTERNAL_SERVER_ERROR", {
				message: "The sample came back empty. Try again.",
			});
		}

		// Someone who may only read sees the sample, and it is theirs alone.
		if (!mayStore) {
			return {
				content,
				generatedAt: new Date().toISOString(),
				reused: false,
			};
		}
		const saved = await saveReportTemplateSample({
			templateId: template.id,
			contentHash,
			content,
		});
		return {
			content: saved.content,
			generatedAt: saved.generatedAt.toISOString(),
			reused: false,
		};
	});
