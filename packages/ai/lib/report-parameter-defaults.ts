import { getBoundPromptForAgent } from "@repo/database";
import {
	isReportParameterPlaceholder,
	MAX_REPORT_PARAMETER_DEFAULT_LENGTH,
} from "@repo/database/prisma/queries/lib/report-template-defaults";
import { logger } from "@repo/logs";
import { renderTemplate } from "@repo/utils";
import {
	REPORT_PARAMETER_DEFAULTS_FALLBACK_BODY,
	REPORT_PARAMETER_DEFAULTS_PROMPT_AGENT_KEY,
} from "@repo/utils/report-parameter-defaults-prompt";
import { generateText, type LanguageModel, Output } from "ai";
import { z } from "zod";
import {
	AIProviderNotConfiguredError,
	getAIModelWithMetadata,
} from "./dynamic-model-selector";
import { findAiUsageLimitError } from "./find-usage-limit-error";
import { requireStructuredOutput } from "./structured-output";
import { logModelUsageAsync } from "./usage-logging";

/** A short answer to a few short settings; this bounds what one report can spend. */
const MAX_OUTPUT_TOKENS = 600;

/**
 * A list of pairs rather than a record, which strict structured-output routes
 * accept. An answer that does not fit is asked for again as plain text, where
 * `acceptedValues` keeps whichever entries are usable.
 */
const RESPONSE_SCHEMA = z.object({
	values: z.array(z.object({ key: z.string(), value: z.string() })),
});

export type ReportParameterToSuggest = {
	key: string;
	description?: string;
};

export type ReportParameterDefaultsRequest = {
	parameters: ReportParameterToSuggest[];
	project: { name: string; description?: string | null };
	template: { name: string; description?: string | null };
	context: {
		userId: string;
		organizationId?: string;
		projectId?: string;
	};
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parameterLines(parameters: ReportParameterToSuggest[]): string {
	return parameters
		.map(({ key, description }) =>
			description ? `${key}: ${description}` : key,
		)
		.join("\n");
}

/** The JSON object in a model's plain text: bare, fenced or among other words. */
function valuesFromText(text: string): unknown {
	const start = text.indexOf("{");
	const end = text.lastIndexOf("}");
	if (start === -1 || end <= start) {
		return null;
	}
	try {
		return JSON.parse(text.slice(start, end + 1));
	} catch {
		return null;
	}
}

/** The answers worth showing: asked for, text, within the length a parameter holds. */
function acceptedValues(
	answer: unknown,
	parameters: ReportParameterToSuggest[],
): Record<string, string> {
	const wanted = new Set(parameters.map((parameter) => parameter.key));
	const accepted: Record<string, string> = {};
	const entries =
		isRecord(answer) && Array.isArray(answer.values) ? answer.values : [];
	for (const entry of entries) {
		if (
			!isRecord(entry) ||
			typeof entry.key !== "string" ||
			typeof entry.value !== "string"
		) {
			continue;
		}
		const text = entry.value.trim();
		if (
			wanted.has(entry.key) &&
			text &&
			text.length <= MAX_REPORT_PARAMETER_DEFAULT_LENGTH &&
			!isReportParameterPlaceholder(text)
		) {
			accepted[entry.key] = text;
		}
	}
	return accepted;
}

/**
 * Asks with structured output, then as plain text for the few providers that
 * refuse it. A usage limit is not a malformed answer, so it is not asked again.
 */
async function askForValues(model: LanguageModel, prompt: string) {
	try {
		const generated = await requireStructuredOutput(
			generateText({
				model,
				output: Output.object({ schema: RESPONSE_SCHEMA }),
				prompt,
				maxOutputTokens: MAX_OUTPUT_TOKENS,
			}),
		);
		return { answer: generated.output, usage: generated.usage };
	} catch (structuredOutputError) {
		const limitError = findAiUsageLimitError(structuredOutputError);
		if (limitError) {
			throw limitError;
		}
		logger.warn(
			"[report-parameter-defaults] structured output failed; asking as plain text",
			structuredOutputError,
		);
		const result = await generateText({
			model,
			prompt,
			maxOutputTokens: MAX_OUTPUT_TOKENS,
		});
		return { answer: valuesFromText(result.text), usage: result.usage };
	}
}

/**
 * Suggests starting values for a new report's settings from its project's name
 * and description. Never throws: any failure (no provider, a usage limit, a bad
 * answer) returns what it has, usually nothing, and the settings stay empty for
 * the person to fill.
 *
 * Follows the work item title generator: the prompt comes from the Prompt
 * Library binding with an in-memory fallback, on the SIMPLE model.
 */
export async function generateReportParameterDefaults({
	parameters,
	project,
	template,
	context,
}: ReportParameterDefaultsRequest): Promise<Record<string, string>> {
	if (parameters.length === 0 || !project.name.trim()) {
		return {};
	}
	try {
		const boundPrompt = await getBoundPromptForAgent({
			agentName: REPORT_PARAMETER_DEFAULTS_PROMPT_AGENT_KEY,
			documentType: "GENERAL",
			storyKind: null,
			userId: context.userId,
			organizationId: context.organizationId,
		});
		const { model, metadata, trackUsage } = await getAIModelWithMetadata(
			{ taskType: "SIMPLE" },
			{
				userId: context.userId,
				organizationId: context.organizationId,
				projectId: context.projectId,
				featureKey: "report-parameter-defaults",
			},
		);
		const rendered = await renderTemplate({
			format: boundPrompt?.format ?? "HANDLEBARS",
			template:
				boundPrompt?.version?.content ??
				REPORT_PARAMETER_DEFAULTS_FALLBACK_BODY,
			variables: {
				project_name: project.name.trim(),
				project_description: project.description?.trim() ?? "",
				template_name: template.name.trim(),
				template_description: template.description?.trim() ?? "",
				parameters: parameterLines(parameters),
			},
			escape: false,
		});
		if (rendered.error) {
			logger.warn(
				"[report-parameter-defaults] prompt render failed; using raw body",
				{ error: rendered.error },
			);
		}

		const startedAt = Date.now();
		const { answer, usage } = await askForValues(model, rendered.rendered);
		trackUsage();
		logModelUsageAsync({
			context: {
				userId: context.userId,
				organizationId: context.organizationId,
			},
			metadata,
			taskType: "SIMPLE",
			usage,
			latencyMs: Date.now() - startedAt,
			projectId: context.projectId,
		});
		return acceptedValues(answer, parameters);
	} catch (error) {
		if (error instanceof AIProviderNotConfiguredError) {
			logger.info(
				"[report-parameter-defaults] no AI provider configured; leaving values empty",
			);
		} else {
			logger.warn(
				"[report-parameter-defaults] generation failed; leaving values empty",
				error,
			);
		}
		return {};
	}
}
