import {
	isProjectAnsweredParameter,
	isReportParameterPlaceholder,
	repositoryParameterPart,
} from "./report-template-defaults";

/**
 * Which of a template's parameters AI may suggest a starting value for. Pure, so
 * the create dialog's request and the one-click path share one answer.
 */

/**
 * How a report template parameter that holds a date or a period is edited.
 *
 * - `date`: one calendar day, stored as `yyyy-MM-dd`.
 * - `period`: a span the AI reads as text, such as "Last 2 weeks",
 *   "Sprint 42" or "2026-03-01 to 2026-03-31".
 */
type DateParameterKind = "date" | "period";

/**
 * Words that mark a parameter as a date only when they are a whole word of its
 * name: "startDate" and "period_end" match, "format", "trend" and "backend"
 * do not.
 */
const DATE_WORDS = new Set([
	"date",
	"dates",
	"datetime",
	"timestamp",
	"deadline",
	"due",
	"since",
	"until",
	"start",
	"end",
]);
const PERIOD_WORDS = new Set(["period", "timeframe", "timespan"]);
/** Words that make a start/end name about something other than time. */
const NON_DATE_WORDS = new Set(["with", "index", "offset", "position", "page"]);

/** Split a parameter name into lower-case words at camelCase, snake_case and kebab-case boundaries. */
export function parameterNameWords(name: string): string[] {
	return name
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
		.split(/[^A-Za-z0-9]+/)
		.filter(Boolean)
		.map((word) => word.toLowerCase());
}

export function classifyDateParameter(
	name: string,
	schema: { format?: string },
): DateParameterKind | null {
	if (schema.format === "date" || schema.format === "date-time") {
		return "date";
	}

	const words = parameterNameWords(name);
	if (words.some((word) => PERIOD_WORDS.has(word))) {
		return "period";
	}
	if (words.includes("range") && words.includes("date")) {
		return "period";
	}
	if (words.some((word) => NON_DATE_WORDS.has(word))) {
		return null;
	}
	if (words.some((word) => DATE_WORDS.has(word))) {
		return "date";
	}

	// "from" and "to" are dates only on their own ("sendTo" is a recipient);
	// "at" only as the last word of a longer name ("createdAt", "updated_at").
	if (words.length === 1 && (words[0] === "from" || words[0] === "to")) {
		return "date";
	}
	if (words.length > 1 && words[words.length - 1] === "at") {
		return "date";
	}
	return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasValue(value: unknown): boolean {
	return typeof value === "string"
		? value.trim().length > 0
		: value !== undefined && value !== null;
}

/**
 * The parameters AI may fill: empty after every other source of a value, free
 * text, and not marked `aiDefault: false`. An enum has its own choices and a
 * date or period is not a guess. A value the project answers (its name, its
 * repository) comes from the project or stays empty, and a formatted value
 * (an email address, a link) would be invented.
 */
export function aiFillableParameters(
	parameters: unknown,
	filled: Record<string, unknown>,
): Array<{ key: string; description?: string }> {
	const properties =
		isRecord(parameters) && isRecord(parameters.properties)
			? parameters.properties
			: {};
	const fillable: Array<{ key: string; description?: string }> = [];
	for (const [key, property] of Object.entries(properties)) {
		if (!isRecord(property) || hasValue(filled[key])) {
			continue;
		}
		const format =
			typeof property.format === "string" ? property.format : undefined;
		if (
			property.aiDefault === false ||
			Array.isArray(property.enum) ||
			(property.type !== undefined && property.type !== "string") ||
			(format !== undefined && format !== "textarea") ||
			classifyDateParameter(key, { format }) !== null ||
			isReportParameterPlaceholder(property.default) ||
			isProjectAnsweredParameter(key) ||
			repositoryParameterPart(key) !== null
		) {
			continue;
		}
		const description =
			typeof property.description === "string"
				? property.description.trim()
				: "";
		fillable.push({ key, ...(description ? { description } : {}) });
	}
	return fillable;
}
