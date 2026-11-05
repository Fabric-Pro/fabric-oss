/**
 * The form behind a template's "Defaults" dialog: an organization's or a
 * project's starting values for the reports created from the template.
 * Pure, so the dialog and its tests read the same rules. The API resolves the
 * scopes (project over organization over template) when a report is created.
 */

export const DEFAULT_SCHEDULE_FREQUENCIES = [
	"daily",
	"weekly",
	"biweekly",
	"monthly",
	"quarterly",
] as const;

export type DefaultScheduleFrequency =
	(typeof DEFAULT_SCHEDULE_FREQUENCIES)[number];

export const FREQUENCY_LABEL: Record<DefaultScheduleFrequency, string> = {
	daily: "Daily",
	weekly: "Weekly",
	biweekly: "Bi-weekly",
	monthly: "Monthly",
	quarterly: "Quarterly",
};

export type ReportDefaultsScope = "PROJECT" | "ORGANIZATION";

type TemplateParameterField = {
	key: string;
	title: string;
	required: boolean;
	description?: string;
};

/**
 * An organization's or a project's default report instructions and AI task
 * prompts (keyed like the report's `customAiTasks`), applied to the reports
 * created there.
 */
export type ReportPromptDefaults = {
	userPrompt?: string;
	aiTasks?: Record<string, string>;
	systemPrompt?: string;
};

type SavedReportDefaults = {
	parameterDefaults: Record<string, string | number | boolean>;
	context: Record<string, string>;
	schedule: { frequency: DefaultScheduleFrequency } | null;
	prompts?: ReportPromptDefaults | null;
};

type ReportDefaultsPayload = {
	parameterDefaults: Record<string, string | number | boolean> | null;
	context: Record<string, string> | null;
	schedule: { frequency: DefaultScheduleFrequency } | null;
	/** Omitted keeps the stored prompts; null clears them. */
	prompts?: ReportPromptDefaults | null;
};

export type ReportDefaultsDraft = {
	parameters: Record<string, string>;
	frequency: DefaultScheduleFrequency | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The template's parameters, in the order its schema lists them. */
export function templateParameterFields(
	parameters: unknown,
): TemplateParameterField[] {
	if (!isRecord(parameters) || !isRecord(parameters.properties)) {
		return [];
	}
	const required = new Set(
		Array.isArray(parameters.required)
			? parameters.required.filter(
					(key): key is string => typeof key === "string",
				)
			: [],
	);
	return Object.entries(parameters.properties).map(([key, property]) => {
		const description =
			isRecord(property) && typeof property.description === "string"
				? property.description.trim()
				: "";
		return {
			key,
			title:
				isRecord(property) && typeof property.title === "string"
					? property.title
					: key,
			required: required.has(key),
			...(description ? { description } : {}),
		};
	});
}

export function draftFromDefaults(
	saved: SavedReportDefaults | null,
): ReportDefaultsDraft {
	return {
		parameters: Object.fromEntries(
			Object.entries(saved?.parameterDefaults ?? {}).map(
				([key, value]) => [key, String(value)],
			),
		),
		frequency: saved?.schedule?.frequency ?? null,
	};
}

/**
 * What a save sends: the filled parameters and the schedule, keeping the
 * context the scope already holds (the dialog does not edit it). Prompts are
 * left out, so the API keeps the stored ones. `null` when nothing is left,
 * which clears the scope; never while the scope still holds prompts, which
 * clearing would drop.
 */
export function defaultsFromDraft(
	draft: ReportDefaultsDraft,
	saved: SavedReportDefaults | null,
): {
	parameterDefaults: Record<string, string> | null;
	context: Record<string, string> | null;
	schedule: { frequency: DefaultScheduleFrequency } | null;
} | null {
	const parameterDefaults = Object.fromEntries(
		Object.entries(draft.parameters)
			.map(([key, value]) => [key, value.trim()] as const)
			.filter(([, value]) => value.length > 0),
	);
	const context = saved?.context ?? {};
	const hasParameters = Object.keys(parameterDefaults).length > 0;
	const hasContext = Object.keys(context).length > 0;
	if (
		!hasParameters &&
		!hasContext &&
		draft.frequency === null &&
		!saved?.prompts
	) {
		return null;
	}
	return {
		parameterDefaults: hasParameters ? parameterDefaults : null,
		context: hasContext ? context : null,
		schedule: scheduleFromDraft(draft, saved),
	};
}

/**
 * The dialog edits only the frequency: an unchanged one sends the saved schedule
 * whole, so its time and day stay and the API sees no change to it.
 */
function scheduleFromDraft(
	draft: ReportDefaultsDraft,
	saved: SavedReportDefaults | null,
): SavedReportDefaults["schedule"] {
	if (!draft.frequency) {
		return null;
	}
	return saved?.schedule?.frequency === draft.frequency
		? saved.schedule
		: { frequency: draft.frequency };
}

/** The scope's saved values, sent back unchanged when only its prompts change. */
function savedDefaultsPayload(
	saved: SavedReportDefaults | null,
): ReportDefaultsPayload {
	const parameterDefaults = saved?.parameterDefaults ?? {};
	const context = saved?.context ?? {};
	return {
		parameterDefaults:
			Object.keys(parameterDefaults).length > 0
				? parameterDefaults
				: null,
		context: Object.keys(context).length > 0 ? context : null,
		schedule: saved?.schedule ?? null,
	};
}

/**
 * A scope's default prompts with a report's on top: the report's
 * instructions when it has them, otherwise the stored ones, and every stored
 * AI task prompt the report does not change kept. The API replaces the stored
 * prompts whole, so a report that carries only some of them must not drop
 * the rest.
 */
export function mergeReportPromptDefaults(
	stored: ReportPromptDefaults | null | undefined,
	report: ReportPromptDefaults,
): ReportPromptDefaults {
	const userPrompt = report.userPrompt ?? stored?.userPrompt;
	const aiTasks = { ...stored?.aiTasks, ...report.aiTasks };
	const systemPrompt = report.systemPrompt ?? stored?.systemPrompt;
	return {
		...(userPrompt !== undefined ? { userPrompt } : {}),
		...(Object.keys(aiTasks).length > 0 ? { aiTasks } : {}),
		...(systemPrompt !== undefined ? { systemPrompt } : {}),
	};
}

/**
 * What setting a report's prompts as a default sends: the report's prompts
 * merged over the stored ones, with the scope's other defaults for the template
 * kept as they are.
 */
export function defaultsWithPrompts(
	saved: SavedReportDefaults | null,
	prompts: ReportPromptDefaults,
): ReportDefaultsPayload {
	return {
		...savedDefaultsPayload(saved),
		prompts: mergeReportPromptDefaults(saved?.prompts, prompts),
	};
}

/**
 * What setting a report's values as a default sends: its parameter values
 * over the scope's stored ones and, when given, its prompts merged over the
 * stored prompts. Everything else the scope holds is kept, and prompts left
 * out stay as they are stored.
 */
export function defaultsWithReportValues(
	saved: SavedReportDefaults | null,
	values: {
		prompts?: ReportPromptDefaults;
		parameterDefaults?: Record<string, string | number | boolean>;
	},
): ReportDefaultsPayload {
	const base = values.prompts
		? defaultsWithPrompts(saved, values.prompts)
		: savedDefaultsPayload(saved);
	return values.parameterDefaults
		? {
				...base,
				parameterDefaults: {
					...base.parameterDefaults,
					...values.parameterDefaults,
				},
			}
		: base;
}

/** What "Clear default prompts" sends: the other defaults kept, the prompts cleared. */
export function defaultsWithoutPrompts(
	saved: SavedReportDefaults | null,
): ReportDefaultsPayload {
	return { ...savedDefaultsPayload(saved), prompts: null };
}
