/**
 * The defaults a new report takes from its organization's and its project's
 * overrides of a template, resolved project over organization over the
 * template's own. Pure, so the create path and its tests share one answer.
 */

type ReportParameterValue = string | number | boolean;

type ReportTemplateOverrideValues = {
	parameterDefaults: unknown;
	context: unknown;
	schedule: unknown;
	prompts?: unknown;
};

/**
 * An organization's or a project's default prompts for the reports created from
 * a template: the report instructions and, per AI task (keyed like
 * `reportAiTaskKey`: outputVariable, or `agent-<index>`), the task prompt.
 */
export type ReportTemplatePromptDefaults = {
	userPrompt?: string;
	aiTasks?: Record<string, string>;
	/** The system prompt the AI tasks run under, over the template's own. */
	systemPrompt?: string;
};

export type ResolvedReportTemplateDefaults = {
	parameterDefaults: Record<string, ReportParameterValue>;
	context: Record<string, string>;
	/** Raw schedule input; undefined when neither override sets one. */
	schedule: unknown;
	/** Project over organization, per prompt; undefined when neither sets one. */
	prompts?: ReportTemplatePromptDefaults;
	/**
	 * The project's own prompts: what applies to an organization's own template,
	 * whose organization prompts are stale copies.
	 */
	projectPrompts?: ReportTemplatePromptDefaults;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parameterValues(value: unknown): Record<string, ReportParameterValue> {
	if (!isRecord(value)) {
		return {};
	}
	return Object.fromEntries(
		Object.entries(value).filter(
			(entry): entry is [string, ReportParameterValue] =>
				typeof entry[1] === "string" ||
				typeof entry[1] === "number" ||
				typeof entry[1] === "boolean",
		),
	);
}

function textValues(value: unknown): Record<string, string> {
	if (!isRecord(value)) {
		return {};
	}
	return Object.fromEntries(
		Object.entries(value).filter(
			(entry): entry is [string, string] => typeof entry[1] === "string",
		),
	);
}

/** Whether a project fills this parameter by itself: a "project name" parameter takes the project's. */
export function isProjectAnsweredParameter(key: string): boolean {
	return key.toLowerCase().replace(/[-_\s]/g, "") === "projectname";
}

const REPOSITORY_OWNER_PARAMETERS = new Set([
	"owner",
	"repoowner",
	"repositoryowner",
	"githubowner",
]);
const REPOSITORY_NAME_PARAMETERS = new Set([
	"repo",
	"reponame",
	"repository",
	"repositoryname",
	"githubrepo",
]);

/** Which part of a repository this parameter asks for, when it asks for one. */
export function repositoryParameterPart(key: string): "owner" | "name" | null {
	const normalized = key.toLowerCase().replace(/[-_\s]/g, "");
	if (REPOSITORY_OWNER_PARAMETERS.has(normalized)) {
		return "owner";
	}
	return REPOSITORY_NAME_PARAMETERS.has(normalized) ? "name" : null;
}

/** The longest text a template or a default holds for one parameter. */
export const MAX_REPORT_PARAMETER_DEFAULT_LENGTH = 2000;

/** A `{{TODAY}}`-style default, which a run does not resolve and the report page asks about instead. */
export function isReportParameterPlaceholder(value: unknown): boolean {
	return typeof value === "string" && value.includes("{{");
}

/**
 * The values a template's parameters give a new report: each property's
 * `default`, except a placeholder.
 */
export function templateParameterDefaults(
	parameters: unknown,
): Record<string, ReportParameterValue> {
	const properties =
		isRecord(parameters) && isRecord(parameters.properties)
			? parameters.properties
			: {};
	return parameterValues(
		Object.fromEntries(
			Object.entries(properties)
				.map(([key, property]) => [
					key,
					isRecord(property) ? property.default : undefined,
				])
				.filter(
					([, value]) =>
						typeof value !== "string" ||
						(value.trim().length > 0 &&
							!isReportParameterPlaceholder(value)),
				),
		),
	);
}

/**
 * The prompts a stored or submitted value holds, without blank entries;
 * undefined when nothing is left.
 */
export function readReportTemplatePromptDefaults(
	value: unknown,
): ReportTemplatePromptDefaults | undefined {
	if (!isRecord(value)) {
		return undefined;
	}
	const userPrompt =
		typeof value.userPrompt === "string" && value.userPrompt.trim()
			? value.userPrompt
			: undefined;
	const aiTasks = Object.fromEntries(
		Object.entries(textValues(value.aiTasks)).filter(([, task]) =>
			task.trim(),
		),
	);
	const systemPrompt =
		typeof value.systemPrompt === "string" && value.systemPrompt.trim()
			? value.systemPrompt
			: undefined;
	const hasAiTasks = Object.keys(aiTasks).length > 0;
	if (!userPrompt && !hasAiTasks && !systemPrompt) {
		return undefined;
	}
	return {
		...(userPrompt ? { userPrompt } : {}),
		...(hasAiTasks ? { aiTasks } : {}),
		...(systemPrompt ? { systemPrompt } : {}),
	};
}

/**
 * Whether a default prompt that applies to a new report was last written by
 * someone other than `callerId`. A row with no recorded author counts as someone
 * else's. The organization's prompts do not apply to its own template.
 */
export function promptDefaultsWrittenByOthers(
	stored: {
		organization: { prompts?: unknown; updatedById: string | null } | null;
		project: { prompts?: unknown; updatedById: string | null } | null;
	},
	callerId: string,
	{ organizationPromptsApply }: { organizationPromptsApply: boolean },
): boolean {
	return [
		organizationPromptsApply ? stored.organization : null,
		stored.project,
	].some(
		(row) =>
			row !== null &&
			readReportTemplatePromptDefaults(row.prompts) !== undefined &&
			row.updatedById !== callerId,
	);
}

export function mergeReportTemplateOverrides(
	organization: ReportTemplateOverrideValues | null,
	project: ReportTemplateOverrideValues | null,
): ResolvedReportTemplateDefaults {
	const organizationPrompts = readReportTemplatePromptDefaults(
		organization?.prompts,
	);
	const projectPrompts = readReportTemplatePromptDefaults(project?.prompts);
	const userPrompt =
		projectPrompts?.userPrompt ?? organizationPrompts?.userPrompt;
	const aiTasks = {
		...organizationPrompts?.aiTasks,
		...projectPrompts?.aiTasks,
	};
	const systemPrompt =
		projectPrompts?.systemPrompt ?? organizationPrompts?.systemPrompt;
	return {
		parameterDefaults: {
			...parameterValues(organization?.parameterDefaults),
			...parameterValues(project?.parameterDefaults),
		},
		context: {
			...textValues(organization?.context),
			...textValues(project?.context),
		},
		schedule: project?.schedule ?? organization?.schedule ?? undefined,
		prompts: readReportTemplatePromptDefaults({
			userPrompt,
			aiTasks,
			systemPrompt,
		}),
		projectPrompts,
	};
}
