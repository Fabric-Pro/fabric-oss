import { z } from "zod";

/** A deliberately small JSON Schema subset; not a general JSON Schema engine. */
export interface ResultJsonSchema {
	type:
		| "object"
		| "array"
		| "string"
		| "number"
		| "integer"
		| "boolean"
		| "null";
	properties?: Record<string, ResultJsonSchema>;
	required?: string[];
	additionalProperties?: false;
	items?: ResultJsonSchema;
	enum?: Array<string | number | boolean | null>;
	minimum?: number;
	maximum?: number;
	minLength?: number;
	maxLength?: number;
	minItems?: number;
	maxItems?: number;
}
const jsonType = z.enum([
	"object",
	"array",
	"string",
	"number",
	"integer",
	"boolean",
	"null",
]);
const primitive = z.union([
	z.string().max(512),
	z.number().finite(),
	z.boolean(),
	z.null(),
]);
const propertyName = z
	.string()
	.min(1)
	.max(200)
	.refine((v) => !["__proto__", "constructor", "prototype"].includes(v));
const shallowSchema = z.strictObject({
	type: jsonType,
	properties: z.record(propertyName, z.unknown()).optional(),
	required: z.array(propertyName).max(20).optional(),
	additionalProperties: z.literal(false).optional(),
	items: z.unknown().optional(),
	enum: z.array(primitive).min(1).max(20).optional(),
	minimum: z.number().finite().optional(),
	maximum: z.number().finite().optional(),
	minLength: z.number().int().min(0).max(1_048_576).optional(),
	maxLength: z.number().int().min(0).max(1_048_576).optional(),
	minItems: z.number().int().min(0).max(10_000).optional(),
	maxItems: z.number().int().min(0).max(10_000).optional(),
});
function validSchema(raw: unknown): raw is ResultJsonSchema {
	const pending = [{ value: raw, depth: 0 }];
	let count = 0;
	while (pending.length) {
		const node = pending.pop();
		if (!node || ++count > 64 || node.depth > 8) {
			return false;
		}
		const parsed = shallowSchema.safeParse(node.value);
		if (!parsed.success) {
			return false;
		}
		const s = parsed.data;
		if (s.enum?.some((value) => !typeMatches(value, s.type))) {
			return false;
		}

		if (
			(s.properties ||
				s.required ||
				s.additionalProperties !== undefined) &&
			s.type !== "object"
		) {
			return false;
		}
		if (
			(s.items !== undefined ||
				s.minItems !== undefined ||
				s.maxItems !== undefined) &&
			s.type !== "array"
		) {
			return false;
		}
		if (
			(s.minLength !== undefined || s.maxLength !== undefined) &&
			s.type !== "string"
		) {
			return false;
		}
		if (
			(s.minimum !== undefined || s.maximum !== undefined) &&
			s.type !== "number" &&
			s.type !== "integer"
		) {
			return false;
		}
		if (
			(s.minimum ?? Number.NEGATIVE_INFINITY) >
				(s.maximum ?? Number.POSITIVE_INFINITY) ||
			(s.minLength ?? 0) > (s.maxLength ?? Number.POSITIVE_INFINITY) ||
			(s.minItems ?? 0) > (s.maxItems ?? Number.POSITIVE_INFINITY)
		) {
			return false;
		}
		if (s.properties) {
			const children = Object.values(s.properties);
			if (children.length > 20) {
				return false;
			}
			for (const value of children) {
				pending.push({ value, depth: node.depth + 1 });
			}
		}
		if (s.items !== undefined) {
			pending.push({ value: s.items, depth: node.depth + 1 });
		}
	}
	return true;
}
// The shallow shape keeps MCP/JSON Schema generation representable. The refinement
// validates every nested node before this typed schema returns a value.
export const resultJsonSchema = shallowSchema
	.refine(
		validSchema,
		"Use the bounded Fabric JSON schema subset (64 nodes, depth 8); references, patterns and extensions are unsupported.",
	)
	.describe(
		"Fabric JSON schema subset; child properties/items follow the same subset, maximum64 nodes and depth8. No references, patterns or extensions.",
	) as z.ZodType<ResultJsonSchema>;

const phrase = z
	.string()
	.min(1)
	.max(512)
	.refine((v) => v.trim().length > 0);
const pointer = z
	.string()
	.max(1024)
	.refine(
		(v) =>
			v === "" ||
			(v.startsWith("/") &&
				v.split("/").length <= 17 &&
				!/~(?:[^01]|$)/.test(v) &&
				v
					.slice(1)
					.split("/")
					.every(
						(p) =>
							!["__proto__", "constructor", "prototype"].includes(
								p.replace(/~1/g, "/").replace(/~0/g, "~"),
							),
					)),
	);
export const resultJsonAssertionSchema = z
	.strictObject({
		pointer,
		type: jsonType.optional(),
		equals: primitive.optional(),
		minimum: z.number().finite().optional(),
		maximum: z.number().finite().optional(),
	})
	.refine(
		(v) =>
			v.type !== undefined ||
			Object.hasOwn(v, "equals") ||
			v.minimum !== undefined ||
			v.maximum !== undefined,
		"Add a value or type check.",
	)
	.refine(
		(v) =>
			(v.minimum ?? Number.NEGATIVE_INFINITY) <=
			(v.maximum ?? Number.POSITIVE_INFINITY),
		"Minimum must not exceed maximum.",
	);
export const resultQualityCheckFields = {
	version: z.union([z.literal(1), z.literal(2)]).optional(),
	requiredPhrases: z.array(phrase).max(20).default([]),
	forbiddenPhrases: z.array(phrase).max(20).default([]),
	jsonSchema: resultJsonSchema.optional(),
	jsonAssertions: z
		.array(resultJsonAssertionSchema)
		.min(1)
		.max(20)
		.optional(),
	grounding: z.strictObject({ requireCitations: z.literal(true) }).optional(),
};
export function validResultQualityChecks(v: {
	version?: number;
	requiredPhrases: string[];
	forbiddenPhrases: string[];
	jsonSchema?: unknown;
	jsonAssertions?: unknown[];
	grounding?: unknown;
}): boolean {
	const richer =
		v.jsonSchema !== undefined ||
		v.jsonAssertions !== undefined ||
		v.grounding !== undefined;
	return (
		(!richer || v.version === 2) &&
		(v.requiredPhrases.length + v.forbiddenPhrases.length > 0 || richer)
	);
}
export const resultQualityChecksSchema = z
	.strictObject(resultQualityCheckFields)
	.refine(
		validResultQualityChecks,
		"Add at least one check; JSON and grounding checks require version 2.",
	);
export type ResultQualityChecks = z.infer<typeof resultQualityChecksSchema>;
export const RESULT_QUALITY_SCORER_VERSION = "fabric-deterministic-v1" as const;
export const resultQualityGradeFields = {
	version: z.literal(2),
	method: z.literal("deterministic"),
	scorerVersion: z.literal(RESULT_QUALITY_SCORER_VERSION),
	status: z.enum(["PASSED", "FAILED", "NOT_ASSESSED"]),
	passed: z.number().int().min(0).max(63),
	total: z.number().int().min(1).max(63),
	unavailable: z.number().int().min(0).max(63),
	results: z
		.array(
			z.strictObject({
				kind: z.enum([
					"required",
					"forbidden",
					"json",
					"schema",
					"grounding",
				]),
				index: z.number().int().min(0).max(19),
				passed: z.boolean(),
				available: z.boolean(),
			}),
		)
		.min(1)
		.max(63),
};
export function validResultQualityGrade(
	v: z.infer<z.ZodObject<typeof resultQualityGradeFields>>,
): boolean {
	const passed = v.results.filter((r) => r.available && r.passed).length;
	const unavailable = v.results.filter((r) => !r.available).length;
	const failed = v.results.some((r) => r.available && !r.passed);
	return (
		v.total === v.results.length &&
		v.passed === passed &&
		v.unavailable === unavailable &&
		v.results.every((r) => r.available || !r.passed) &&
		v.status ===
			(failed ? "FAILED" : unavailable ? "NOT_ASSESSED" : "PASSED")
	);
}
export const resultQualityGradeSchema = z
	.strictObject(resultQualityGradeFields)
	.refine(
		validResultQualityGrade,
		"Report counts and status must match its checks.",
	);
export type ResultQualityGrade = z.infer<typeof resultQualityGradeSchema>;
function typeMatches(value: unknown, type: ResultJsonSchema["type"]): boolean {
	if (type === "null") {
		return value === null;
	}
	if (type === "array") {
		return Array.isArray(value);
	}
	if (type === "object") {
		return (
			value !== null && typeof value === "object" && !Array.isArray(value)
		);
	}
	if (type === "integer") {
		return typeof value === "number" && Number.isSafeInteger(value);
	}
	if (type === "number") {
		return typeof value === "number" && Number.isFinite(value);
	}
	return typeof value === type;
}
function matchesSchema(
	value: unknown,
	schema: ResultJsonSchema,
	budget: { remaining: number; exhausted: boolean },
): boolean {
	if (--budget.remaining < 0) {
		budget.exhausted = true;
		return false;
	}
	if (!typeMatches(value, schema.type)) {
		return false;
	}
	if (schema.enum && !schema.enum.some((item) => item === value)) {
		return false;
	}
	if (
		typeof value === "number" &&
		(value < (schema.minimum ?? Number.NEGATIVE_INFINITY) ||
			value > (schema.maximum ?? Number.POSITIVE_INFINITY))
	) {
		return false;
	}
	if (
		typeof value === "string" &&
		(value.length < (schema.minLength ?? 0) ||
			value.length > (schema.maxLength ?? Number.POSITIVE_INFINITY))
	) {
		return false;
	}
	if (Array.isArray(value)) {
		if (
			value.length < (schema.minItems ?? 0) ||
			value.length > (schema.maxItems ?? Number.POSITIVE_INFINITY)
		) {
			return false;
		}
		if (schema.items && value.length > budget.remaining) {
			budget.exhausted = true;
			return false;
		}
		if (
			schema.items &&
			!value.every((item) =>
				matchesSchema(item, schema.items as ResultJsonSchema, budget),
			)
		) {
			return false;
		}
	} else if (value !== null && typeof value === "object") {
		if (schema.required?.some((key) => !Object.hasOwn(value, key))) {
			return false;
		}
		const properties = schema.properties ?? {};
		const entries = Object.entries(value);
		if (entries.length > budget.remaining) {
			budget.exhausted = true;
			return false;
		}
		for (const [key, child] of entries) {
			if (!Object.hasOwn(properties, key)) {
				if (schema.additionalProperties === false) {
					return false;
				}
			} else if (!matchesSchema(child, properties[key], budget)) {
				return false;
			}
		}
	}
	return true;
}
function atPointer(
	value: unknown,
	pointerValue: string,
): { found: boolean; value: unknown } {
	if (pointerValue === "") {
		return { found: true, value };
	}
	let current = value;
	for (const raw of pointerValue.slice(1).split("/")) {
		const key = raw.replace(/~1/g, "/").replace(/~0/g, "~");
		if (
			current === null ||
			typeof current !== "object" ||
			!Object.hasOwn(current, key) ||
			(Array.isArray(current) && !/^(0|[1-9][0-9]*)$/.test(key))
		) {
			return { found: false, value: undefined };
		}
		current = (current as Record<string, unknown>)[key];
	}
	return { found: true, value: current };
}
/** Pure recorded-output grading. No I/O, model, retrieval, business execution or secret content in the report. */
export function gradeResultQuality(
	answer: string,
	rawChecks: unknown,
): ResultQualityGrade {
	const checks = resultQualityChecksSchema.parse(rawChecks);
	if (
		!answer.trim() ||
		new TextEncoder().encode(answer).byteLength > 1_048_576
	) {
		throw new Error(
			"A nonempty recorded answer of at most 1 MiB is required.",
		);
	}
	const results: ResultQualityGrade["results"] = [
		...checks.requiredPhrases.map((p, index) => ({
			kind: "required" as const,
			index,
			passed: answer.includes(p),
			available: true,
		})),
		...checks.forbiddenPhrases.map((p, index) => ({
			kind: "forbidden" as const,
			index,
			passed: !answer.includes(p),
			available: true,
		})),
	];
	let json: unknown;
	let parsed = false;
	if (checks.jsonSchema || checks.jsonAssertions) {
		try {
			json = JSON.parse(answer);
			parsed = true;
		} catch {
			/* Invalid JSON fails every JSON check; never repair with a model. */
		}
	}
	if (checks.jsonSchema) {
		const budget = { remaining: 10_000, exhausted: false };
		const passed = parsed && matchesSchema(json, checks.jsonSchema, budget);
		results.push({
			kind: "schema",
			index: 0,
			passed,
			available: !budget.exhausted,
		});
	}
	for (const [index, check] of (checks.jsonAssertions ?? []).entries()) {
		const selected = parsed
			? atPointer(json, check.pointer)
			: { found: false, value: undefined };
		const value = selected.value;
		const passed =
			selected.found &&
			(!check.type || typeMatches(value, check.type)) &&
			(!Object.hasOwn(check, "equals") || value === check.equals) &&
			(check.minimum === undefined ||
				(typeof value === "number" && value >= check.minimum)) &&
			(check.maximum === undefined ||
				(typeof value === "number" && value <= check.maximum));
		results.push({ kind: "json", index, passed, available: true });
	}
	// Citation presence alone is not grounding. Until a trusted runtime evidence adapter exists,
	// this check is explicitly unavailable; client-supplied evidence never certifies a run.
	if (checks.grounding) {
		results.push({
			kind: "grounding",
			index: 0,
			passed: false,
			available: false,
		});
	}
	const unavailable = results.filter((r) => !r.available).length;
	return resultQualityGradeSchema.parse({
		version: 2,
		method: "deterministic",
		scorerVersion: RESULT_QUALITY_SCORER_VERSION,
		status: results.some((r) => r.available && !r.passed)
			? "FAILED"
			: unavailable
				? "NOT_ASSESSED"
				: "PASSED",
		passed: results.filter((r) => r.available && r.passed).length,
		total: results.length,
		unavailable,
		results,
	});
}
/** Scorer formats must match; callers separately pin the expectation revision and output selector. */
export function resultQualityComparisonCompatible(
	a: { version: number; method: string; scorerVersion?: string },
	b: { version: number; method: string; scorerVersion?: string },
): boolean {
	return (
		a.version === b.version &&
		a.method === b.method &&
		a.scorerVersion === b.scorerVersion
	);
}
