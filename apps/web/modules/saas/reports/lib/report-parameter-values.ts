import {
	isProjectAnsweredParameter,
	templateParameterDefaults,
} from "@repo/database/prisma/queries/lib/report-template-defaults";
import type { ParameterSchema } from "../components/SmartParameterInput";

/**
 * The values a person sees in the settings of a report they are creating, and
 * which of them it saves. AI's and the project's values fill a field only while
 * the person has not typed there.
 */

export type ReportParameterField = {
	key: string;
	schema: ParameterSchema;
	required: boolean;
	/** A schema default the server fills, so an empty field is not missing. */
	hasDefault: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

const SCHEMA_TYPES: ReadonlyArray<ParameterSchema["type"]> = [
	"string",
	"number",
	"integer",
	"boolean",
	"array",
];
const SCHEMA_FORMATS: ReadonlyArray<NonNullable<ParameterSchema["format"]>> = [
	"date",
	"date-time",
	"email",
	"uri",
	"textarea",
];

function parameterSchema(property: unknown): ParameterSchema {
	const raw = isRecord(property) ? property : {};
	return {
		type: SCHEMA_TYPES.find((type) => type === raw.type) ?? "string",
		...(typeof raw.description === "string"
			? { description: raw.description }
			: {}),
		...(raw.default !== undefined ? { default: raw.default } : {}),
		...(Array.isArray(raw.enum)
			? {
					enum: raw.enum.filter(
						(option): option is string =>
							typeof option === "string",
					),
				}
			: {}),
		format: SCHEMA_FORMATS.find((format) => format === raw.format),
	};
}

/** A template's parameters as form fields, in the order its schema lists them. */
export function reportParameterFields(
	parameters: unknown,
): ReportParameterField[] {
	if (!isRecord(parameters) || !isRecord(parameters.properties)) {
		return [];
	}
	const required = new Set(
		Array.isArray(parameters.required) ? parameters.required : [],
	);
	return Object.entries(parameters.properties).map(([key, property]) => {
		const schema = parameterSchema(property);
		return {
			key,
			schema,
			required: required.has(key),
			hasDefault: schema.default != null && schema.default !== "",
		};
	});
}

/** What the form shows before the server answers: the template's values and the project's name. */
export function initialParameterValues(
	parameters: unknown,
	projectName: string | null | undefined,
): Record<string, string> {
	const values: Record<string, string> = {};
	for (const [key, value] of Object.entries(
		templateParameterDefaults(parameters),
	)) {
		values[key] = String(value);
	}
	const name = projectName?.trim();
	if (name) {
		for (const { key } of reportParameterFields(parameters)) {
			if (isProjectAnsweredParameter(key)) {
				values[key] = name;
			}
		}
	}
	return values;
}

/**
 * The form with these values filled in where it is still empty, unless the
 * person typed there (clearing a field counts). The same object when nothing
 * changes.
 */
export function offerParameterValues(
	current: Record<string, string>,
	offered: Record<string, string | number | boolean>,
	typed: ReadonlySet<string>,
): Record<string, string> {
	let next = current;
	for (const [key, value] of Object.entries(offered)) {
		if (!typed.has(key) && !current[key]?.trim()) {
			next = { ...next, [key]: String(value) };
		}
	}
	return next;
}

/**
 * What the new report saves as its own: what the person typed and what AI
 * filled. Everything else on the form is what the server gives a new report by
 * itself, and leaving it out keeps its type (a number stays a number).
 */
export function parameterValuesToSave(
	values: Record<string, string>,
	typed: ReadonlySet<string>,
	suggested: Readonly<Record<string, string>>,
): Record<string, string> {
	const saved: Record<string, string> = {};
	for (const [key, value] of Object.entries(values)) {
		const chosen =
			typed.has(key) || (key in suggested && suggested[key] === value);
		if (chosen && value.trim()) {
			saved[key] = value;
		}
	}
	return saved;
}

/** The required parameters still empty, by key. */
export function missingRequiredParameters(
	fields: ReportParameterField[],
	values: Record<string, string>,
): string[] {
	return fields
		.filter(
			(field) =>
				field.required &&
				!field.hasDefault &&
				!values[field.key]?.trim(),
		)
		.map((field) => field.key);
}

/**
 * Enough rows to read a short prompt without scrolling inside the field. The
 * width is a guess, so a long prompt stops growing the field at a cap and scrolls
 * in it; the controls under the field stay near.
 */
export function promptFieldRows(prompt: string): number {
	const CHARACTERS_PER_ROW = 80;
	const MINIMUM_ROWS = 4;
	const MAXIMUM_ROWS = 16;
	const rows = prompt
		.split("\n")
		.reduce(
			(total, line) =>
				total +
				Math.max(1, Math.ceil(line.length / CHARACTERS_PER_ROW)),
			0,
		);
	return Math.min(MAXIMUM_ROWS, Math.max(MINIMUM_ROWS, rows + 1));
}
