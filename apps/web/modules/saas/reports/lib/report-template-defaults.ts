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

type SavedReportDefaults = {
	parameterDefaults: Record<string, string | number | boolean>;
	context: Record<string, string>;
	schedule: { frequency: DefaultScheduleFrequency } | null;
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
 * context the scope already holds (the dialog does not edit it). `null`
 * when nothing is left, which clears the scope.
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
	if (!hasParameters && !hasContext && draft.frequency === null) {
		return null;
	}
	return {
		parameterDefaults: hasParameters ? parameterDefaults : null,
		context: hasContext ? context : null,
		schedule: draft.frequency ? { frequency: draft.frequency } : null,
	};
}
