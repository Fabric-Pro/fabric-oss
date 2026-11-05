/**
 * A report template's prompts as the report page edits them: the report
 * instructions (`definition.userPrompt`) and one prompt per AI task, keyed by
 * `reportAiTaskKey` (the task's outputVariable, or `agent-<index>`) like the
 * report's own `fabricConfig.customAiTasks`.
 */

import type {
	Prisma,
	ReportTemplateScope,
} from "@repo/database/prisma/generated/client";
import { MAX_REPORT_PARAMETER_DEFAULT_LENGTH } from "@repo/database/prisma/queries/lib/report-template-defaults";
import { reportAiTaskKey } from "@repo/temporal/report-ai-tasks";
import { z } from "zod";

const MAX_PROMPT_LENGTH = 20_000;
const MAX_AI_TASKS = 50;
const MAX_PARAMETER_DEFAULTS = 50;

/** The prompts a person saves from the report page, to a template or as an organization default. */
export const reportTemplatePromptsSchema = z.object({
	userPrompt: z.string().max(MAX_PROMPT_LENGTH).optional(),
	aiTasks: z
		.record(
			z.string().trim().min(1).max(100),
			z.string().max(MAX_PROMPT_LENGTH),
		)
		.refine(
			(tasks) => Object.keys(tasks).length <= MAX_AI_TASKS,
			"Too many AI task prompts",
		)
		.optional(),
	systemPrompt: z.string().max(MAX_PROMPT_LENGTH).optional(),
});

type ReportTemplatePrompts = z.infer<typeof reportTemplatePromptsSchema>;

/**
 * Whether the organization owns the template. It edits its own templates'
 * prompts on the template, so its own defaults neither set nor apply prompts
 * for them, including prompts stored before the template was published to it.
 * A project's default prompts still apply.
 */
export function isOrganizationOwnedTemplate(
	template: { scope: ReportTemplateScope; organizationId: string | null },
	organizationId: string,
): boolean {
	return (
		template.scope === "ORGANIZATION" &&
		template.organizationId === organizationId
	);
}

function isJsonObject(
	value: Prisma.JsonValue | undefined,
): value is Prisma.JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: Prisma.JsonValue | undefined): string {
	return typeof value === "string" ? value : "";
}

function aiAgents(definition: Prisma.JsonValue): Prisma.JsonValue[] {
	const agents = isJsonObject(definition) ? definition.aiAgents : undefined;
	return Array.isArray(agents) ? agents : [];
}

function aiTaskKey(agent: Prisma.JsonValue, index: number): string {
	const task: Prisma.JsonObject = isJsonObject(agent) ? agent : {};
	return reportAiTaskKey(
		{
			agentId: text(task.agentId),
			task: text(task.task),
			outputVariable: text(task.outputVariable) || undefined,
		},
		index,
	);
}

/** The keys a template's AI task prompts are saved under. */
function reportTemplateAiTaskKeys(definition: Prisma.JsonValue): string[] {
	return aiAgents(definition).map(aiTaskKey);
}

/** The AI task keys in `aiTasks` that name no task of the template. */
export function unknownReportAiTaskKeys(
	definition: Prisma.JsonValue,
	aiTasks: Record<string, string> | undefined,
): string[] {
	const known = new Set(reportTemplateAiTaskKeys(definition));
	return Object.keys(aiTasks ?? {}).filter((key) => !known.has(key));
}

/** The parameter values a person saves from the report page to a template. */
export const reportTemplateParameterDefaultsSchema = z
	.record(
		z.string().trim().min(1).max(100),
		z.union([
			z.string().max(MAX_REPORT_PARAMETER_DEFAULT_LENGTH),
			z.number(),
			z.boolean(),
		]),
	)
	.refine(
		(values) => Object.keys(values).length <= MAX_PARAMETER_DEFAULTS,
		"Too many parameter values",
	);

type ReportTemplateParameterDefaults = z.infer<
	typeof reportTemplateParameterDefaultsSchema
>;

function parameterProperties(parameters: Prisma.JsonValue): Prisma.JsonObject {
	return isJsonObject(parameters) && isJsonObject(parameters.properties)
		? parameters.properties
		: {};
}

/** The keys in `values` that name no parameter of the template. */
export function unknownReportParameterKeys(
	parameters: Prisma.JsonValue,
	values: ReportTemplateParameterDefaults | undefined,
): string[] {
	const known = parameterProperties(parameters);
	return Object.keys(values ?? {}).filter(
		(key) => !Object.hasOwn(known, key),
	);
}

/**
 * The template's parameters with these values as their defaults, which new
 * reports from it start with. Everything else about each parameter is kept.
 * Callers reject unknown keys first (`unknownReportParameterKeys`).
 */
export function withReportTemplateParameterDefaults(
	parameters: Prisma.JsonValue,
	values: ReportTemplateParameterDefaults,
): Prisma.JsonObject {
	const base: Prisma.JsonObject = isJsonObject(parameters) ? parameters : {};
	const properties = parameterProperties(parameters);
	return {
		...base,
		properties: {
			...properties,
			...Object.fromEntries(
				Object.entries(values).map(([key, value]) => {
					const property = properties[key];
					return [
						key,
						{
							...(isJsonObject(property) ? property : {}),
							default: value,
						},
					];
				}),
			),
		},
	};
}

/**
 * The template's Fabric configuration with this system prompt as its default,
 * which a run reads when the report has none of its own.
 */
export function withReportTemplateSystemPrompt(
	fabricConfig: Prisma.JsonValue,
	systemPrompt: string,
): Prisma.JsonObject {
	return {
		...(isJsonObject(fabricConfig) ? fabricConfig : {}),
		defaultSystemPrompt: systemPrompt,
	};
}

/**
 * The template definition with these prompts written in: the report
 * instructions when given, and each named AI task's prompt. Callers reject
 * unknown task keys first (`unknownReportAiTaskKeys`).
 */
export function withReportTemplatePrompts(
	definition: Prisma.JsonValue,
	prompts: ReportTemplatePrompts,
): Prisma.JsonObject {
	const base: Prisma.JsonObject = isJsonObject(definition) ? definition : {};
	const aiTasks = prompts.aiTasks ?? {};
	const hasAiTasks = Object.keys(aiTasks).length > 0;
	return {
		...base,
		...(prompts.userPrompt !== undefined
			? { userPrompt: prompts.userPrompt }
			: {}),
		...(hasAiTasks
			? {
					aiAgents: aiAgents(definition).map((agent, index) => {
						const task = aiTasks[aiTaskKey(agent, index)];
						return task !== undefined && isJsonObject(agent)
							? { ...agent, task }
							: agent;
					}),
				}
			: {}),
	};
}
