/**
 * What a saved report can hand on to the reports made after it: its prompts
 * (`report-prompt-save`) and its parameter values, written to the template, or
 * kept as the organization's or the project's default. Each destination is
 * offered only what new reports there would not already start with, so an
 * offer goes away once its values are saved. Pure, so the menu and its tests
 * read the same rules. The API checks who may do each.
 *
 * Which parameters go where follows the Defaults dialog: only the template's
 * own parameters. A value the project answers by itself is never handed on,
 * because each project answers it with its own. A parameter whose template
 * default is a placeholder such as `{{TODAY}}` is resolved for each run, so
 * one report's value is never handed on either, and neither is a text longer
 * than a default may hold. A value taken from a bound resource, such as a
 * board, belongs to this project alone, so it can become the project's default
 * and not the template's or the organization's.
 */

import {
	isProjectAnsweredParameter,
	isReportParameterPlaceholder,
	MAX_REPORT_PARAMETER_DEFAULT_LENGTH,
} from "@repo/database/prisma/queries/lib/report-template-defaults";
import { savedReportPrompts, templateTaskPrompts } from "./report-prompt-save";
import {
	mergeReportPromptDefaults,
	type ReportPromptDefaults,
	templateParameterFields,
} from "./report-template-defaults";

type ParameterValue = string | number | boolean;
type ParameterValues = Record<string, ParameterValue>;

/** What one destination would take from the report. */
export type ReportConfigurationChanges = {
	prompts?: ReportPromptDefaults;
	parameterDefaults?: ParameterValues;
};

type SavedReport = {
	connections: unknown;
	fabricConfig: unknown;
	parameterDefaults: unknown;
	template: {
		definition: unknown;
		parameters: unknown;
		/** Holds the template's system prompt, which a report's own differs from. */
		fabricConfig?: unknown;
	};
};

type StoredDefaults = {
	parameterDefaults: ParameterValues;
	prompts?: ReportPromptDefaults | null;
} | null;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The report's saved values for its template's parameters, blanks left out. */
function savedReportParameters(report: SavedReport): ParameterValues {
	const saved = isRecord(report.parameterDefaults)
		? report.parameterDefaults
		: {};
	const declared = templateDefaults(report.template.parameters);
	const values: ParameterValues = {};
	for (const { key } of templateParameterFields(report.template.parameters)) {
		const value = saved[key];
		if (
			isProjectAnsweredParameter(key) ||
			isReportParameterPlaceholder(declared[key])
		) {
			continue;
		}
		if (typeof value === "string") {
			const text = value.trim();
			if (text && text.length <= MAX_REPORT_PARAMETER_DEFAULT_LENGTH) {
				values[key] = text;
			}
		} else if (typeof value === "number" || typeof value === "boolean") {
			values[key] = value;
		}
	}
	return values;
}

/** The ids and names of the resources the report is bound to. */
function boundResourceValues(connections: unknown): Set<string> {
	const bindings =
		isRecord(connections) && isRecord(connections.resourceBindings)
			? Object.values(connections.resourceBindings).filter(isRecord)
			: [];
	return new Set(
		bindings
			.flatMap((binding) => [binding.resourceId, binding.resourceName])
			.filter((value): value is string => typeof value === "string"),
	);
}

/** The report's values that may reach beyond its project. */
function sharedReportParameters(report: SavedReport): ParameterValues {
	const bound = boundResourceValues(report.connections);
	return Object.fromEntries(
		Object.entries(savedReportParameters(report)).filter(
			([, value]) => !bound.has(String(value)),
		),
	);
}

/** The defaults the template's own parameters declare, as a new report reads them. */
function templateDefaults(parameters: unknown): Record<string, unknown> {
	const properties =
		isRecord(parameters) && isRecord(parameters.properties)
			? parameters.properties
			: {};
	return Object.fromEntries(
		Object.entries(properties).map(([key, property]) => [
			key,
			isRecord(property) ? property.default : undefined,
		]),
	);
}

/** The values a new report would not already start with. Forms save numbers as text. */
function differingParameters(
	values: ParameterValues,
	baseline: Record<string, unknown>,
): ParameterValues | undefined {
	const differing = Object.fromEntries(
		Object.entries(values).filter(
			([key, value]) => String(baseline[key] ?? "") !== String(value),
		),
	);
	return Object.keys(differing).length > 0 ? differing : undefined;
}

function changesOrNull(
	changes: ReportConfigurationChanges,
): ReportConfigurationChanges | null {
	return changes.prompts || changes.parameterDefaults ? changes : null;
}

/** What "Update template" would write, or `null` when the template already holds it. */
export function templateConfigurationChanges(
	report: SavedReport,
): ReportConfigurationChanges | null {
	const prompts = savedReportPrompts(report);
	return changesOrNull({
		...(prompts ? { prompts } : {}),
		parameterDefaults: differingParameters(
			sharedReportParameters(report),
			templateDefaults(report.template.parameters),
		),
	});
}

/** Whether saving the report's prompts would change the stored default prompts. */
function changesStoredPrompts(
	stored: ReportPromptDefaults | null | undefined,
	prompts: ReportPromptDefaults,
): boolean {
	const merged = mergeReportPromptDefaults(stored, prompts);
	return (
		merged.userPrompt !== stored?.userPrompt ||
		merged.systemPrompt !== stored?.systemPrompt ||
		Object.entries(merged.aiTasks ?? {}).some(
			([key, task]) => stored?.aiTasks?.[key] !== task,
		)
	);
}

/**
 * The stored defaults without the AI task prompts of tasks the template has
 * since dropped. They are sent back with a new prompt, and the API refuses a
 * task the template does not have.
 */
export function storedDefaultsForTemplate<
	Stored extends { prompts?: ReportPromptDefaults | null },
>(stored: Stored | null, definition: unknown): Stored | null {
	const prompts: ReportPromptDefaults | null | undefined = stored?.prompts;
	const aiTasks = prompts?.aiTasks;
	if (!stored || !prompts || !aiTasks) {
		return stored;
	}
	const tasks = templateTaskPrompts(definition);
	return {
		...stored,
		prompts: {
			...prompts,
			aiTasks: Object.fromEntries(
				Object.entries(aiTasks).filter(([key]) => tasks.has(key)),
			),
		},
	};
}

/**
 * What "Set as organization default" would save, or `null` when new reports
 * in the organization already start with it. Prompts only where the
 * organization may hold them: its own templates' prompts live on the template.
 */
export function organizationConfigurationChanges(
	report: SavedReport,
	stored: StoredDefaults,
	{ includePrompts }: { includePrompts: boolean },
): ReportConfigurationChanges | null {
	const prompts = includePrompts ? savedReportPrompts(report) : null;
	return changesOrNull({
		...(prompts && changesStoredPrompts(stored?.prompts, prompts)
			? { prompts }
			: {}),
		parameterDefaults: differingParameters(sharedReportParameters(report), {
			...templateDefaults(report.template.parameters),
			...stored?.parameterDefaults,
		}),
	});
}

/**
 * What "Set as project default" would save, or `null` when new reports in the
 * project already start with it. They start with the project's prompts over the
 * organization's, unless the template is the organization's own, whose
 * organization row holds no prompts that apply.
 */
export function projectConfigurationChanges(
	report: SavedReport,
	stored: {
		organization: StoredDefaults;
		project: StoredDefaults;
		organizationPromptsApply?: boolean;
	},
): ReportConfigurationChanges | null {
	const prompts = savedReportPrompts(report);
	const startingPrompts = mergeReportPromptDefaults(
		stored.organizationPromptsApply === false
			? null
			: stored.organization?.prompts,
		stored.project?.prompts ?? {},
	);
	return changesOrNull({
		...(prompts && changesStoredPrompts(startingPrompts, prompts)
			? { prompts }
			: {}),
		parameterDefaults: differingParameters(savedReportParameters(report), {
			...templateDefaults(report.template.parameters),
			...stored.organization?.parameterDefaults,
			...stored.project?.parameterDefaults,
		}),
	});
}
