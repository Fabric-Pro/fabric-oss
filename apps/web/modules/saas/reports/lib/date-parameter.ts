import { format } from "date-fns";

/**
 * How a report template parameter that holds a date or a period is edited.
 *
 * - `date`: one calendar day, stored as `yyyy-MM-dd`.
 * - `period`: a span the AI reads as text, such as "Last 2 weeks",
 *   "Sprint 42" or "2026-03-01 to 2026-03-31".
 */
export type DateParameterKind = "date" | "period";

type DateParameterSchema = {
	format?: string;
	description?: string;
	default?: unknown;
};

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
	schema: DateParameterSchema,
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

export function isDateParameter(
	name: string,
	schema: DateParameterSchema,
): boolean {
	return classifyDateParameter(name, schema) !== null;
}

export type PeriodPreset = {
	id: string;
	label: string;
	/** The text stored in the parameter; the report's AI reads it as written. */
	value: string;
};

const PERIOD_PRESETS: PeriodPreset[] = [
	{ id: "last-7-days", label: "Last 7 days", value: "Last 7 days" },
	{ id: "last-2-weeks", label: "Last 2 weeks", value: "Last 2 weeks" },
	{ id: "last-30-days", label: "Last 30 days", value: "Last 30 days" },
	{ id: "current-sprint", label: "Current sprint", value: "Current Sprint" },
	{ id: "this-month", label: "This month", value: "This month" },
	{ id: "last-month", label: "Last month", value: "Last month" },
	{ id: "this-quarter", label: "This quarter", value: "This quarter" },
];

/**
 * The relative presets offered for a period parameter. "Current sprint" is
 * offered only where the template already speaks of sprints, because a
 * report without sprint data cannot resolve it.
 */
export function getPeriodPresets(schema: DateParameterSchema): PeriodPreset[] {
	const hint = [
		schema.description ?? "",
		typeof schema.default === "string" ? schema.default : "",
	]
		.join(" ")
		.toLowerCase();
	const mentionsSprint = hint.includes("sprint");
	return PERIOD_PRESETS.filter(
		(preset) => preset.id !== "current-sprint" || mentionsSprint,
	);
}

/** The preset a stored value came from, ignoring case and surrounding space. */
export function findPeriodPreset(
	presets: PeriodPreset[],
	value: string,
): PeriodPreset | undefined {
	const normalized = value.trim().toLowerCase();
	return presets.find((preset) => preset.value.toLowerCase() === normalized);
}

const RANGE_PATTERN = /^(\d{4}-\d{2}-\d{2}) to (\d{4}-\d{2}-\d{2})$/;

/** A custom range is stored as "yyyy-MM-dd to yyyy-MM-dd". */
export function formatPeriodRange(from: Date, to: Date): string {
	return `${format(from, "yyyy-MM-dd")} to ${format(to, "yyyy-MM-dd")}`;
}

export function parsePeriodRange(
	value: string,
): { from: Date; to: Date } | null {
	const match = RANGE_PATTERN.exec(value.trim());
	if (!match) {
		return null;
	}
	// Date-only values are local calendar days, not UTC instants.
	const from = new Date(`${match[1]}T00:00:00`);
	const to = new Date(`${match[2]}T00:00:00`);
	if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
		return null;
	}
	return { from, to };
}
