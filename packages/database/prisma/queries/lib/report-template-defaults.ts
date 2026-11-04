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
};

export type ResolvedReportTemplateDefaults = {
	parameterDefaults: Record<string, ReportParameterValue>;
	context: Record<string, string>;
	/** Raw schedule input; undefined when neither override sets one. */
	schedule: unknown;
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

export function mergeReportTemplateOverrides(
	organization: ReportTemplateOverrideValues | null,
	project: ReportTemplateOverrideValues | null,
): ResolvedReportTemplateDefaults {
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
	};
}
