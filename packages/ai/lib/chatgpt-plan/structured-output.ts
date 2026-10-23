import type { LanguageModelMiddleware } from "ai";

type JsonSchema = Record<string, unknown>;
type JsonObject = Record<string, unknown>;

const isObject = (value: unknown): value is JsonObject =>
	typeof value === "object" && value !== null && !Array.isArray(value);

function resolveRef(schema: unknown, root: JsonSchema): JsonSchema | null {
	let current = schema;
	for (let depth = 0; depth < 16 && isObject(current); depth++) {
		const ref = current.$ref;
		if (typeof ref !== "string") {
			return current;
		}
		if (!ref.startsWith("#")) {
			return null;
		}
		let target: unknown = root;
		for (const segment of ref.slice(1).split("/").filter(Boolean)) {
			target = isObject(target)
				? target[segment.replace(/~1/g, "/").replace(/~0/g, "~")]
				: undefined;
		}
		current = target;
	}
	return null;
}

function branches(schema: JsonSchema): JsonSchema[] {
	return ["anyOf", "oneOf", "allOf"].flatMap((key) =>
		Array.isArray(schema[key]) ? (schema[key] as JsonSchema[]) : [],
	);
}

/** Whether `null` is a value the schema accepts; unknown shapes count as yes. */
function allowsNull(schema: unknown, root: JsonSchema): boolean {
	const resolved = resolveRef(schema, root);
	if (!resolved) {
		return true;
	}
	const { type } = resolved;
	const alternatives = branches(resolved);
	if (type === undefined && alternatives.length === 0) {
		return true;
	}
	return (
		type === "null" ||
		(Array.isArray(type) && type.includes("null")) ||
		resolved.nullable === true ||
		alternatives.some((branch) => allowsNull(branch, root))
	);
}

/** The schemas that describe an object value: the schema and its object branches. */
function objectSchemas(schema: JsonSchema, root: JsonSchema): JsonSchema[] {
	return [schema, ...branches(schema)]
		.map((candidate) => resolveRef(candidate, root))
		.filter((candidate): candidate is JsonSchema =>
			Boolean(candidate && isObject(candidate.properties)),
		);
}

function itemSchemas(schema: JsonSchema, root: JsonSchema): JsonSchema[] {
	return [schema, ...branches(schema)]
		.map((candidate) => resolveRef(candidate, root))
		.flatMap((candidate) =>
			candidate && isObject(candidate.items)
				? [candidate.items as JsonSchema]
				: [],
		);
}

/**
 * The value with every `null` removed from an object property the schema
 * neither requires nor lets be null.
 *
 * Plan strict enforcement is unverified, so the transport sends the schema as
 * non-strict guidance. Its models can answer a field they have nothing
 * for with `null` — the strict-mode convention for "absent". Zod's
 * `.optional()` and `.default()` accept an absent field but refuse `null`, so
 * a correct answer failed validation as "did not match schema". Removing the
 * null hands the field back to the caller's schema as the absence it means,
 * where `.default()` still applies. A null the schema allows is kept, and a
 * required one is left for validation to refuse.
 */
export function dropDisallowedNulls(
	value: unknown,
	schema: unknown,
	root: JsonSchema = isObject(schema) ? schema : {},
): unknown {
	const resolved = resolveRef(schema, root);
	if (!resolved) {
		return value;
	}
	if (Array.isArray(value)) {
		const [items] = itemSchemas(resolved, root);
		return items
			? value.map((item) => dropDisallowedNulls(item, items, root))
			: value;
	}
	if (!isObject(value)) {
		return value;
	}
	const [objectSchema] = objectSchemas(resolved, root);
	if (!objectSchema) {
		return value;
	}
	const properties = objectSchema.properties as Record<string, unknown>;
	const required = Array.isArray(objectSchema.required)
		? (objectSchema.required as string[])
		: [];
	const next: JsonObject = {};
	for (const [key, field] of Object.entries(value)) {
		const fieldSchema = properties[key];
		if (fieldSchema === undefined) {
			next[key] = field;
			continue;
		}
		if (
			field === null &&
			!required.includes(key) &&
			!allowsNull(fieldSchema, root)
		) {
			continue;
		}
		next[key] = dropDisallowedNulls(field, fieldSchema, root);
	}
	return next;
}

/**
 * Applies {@link dropDisallowedNulls} to a structured-output answer from a
 * plan, before the AI SDK validates it — so every `generateObject` and
 * `Output.object` call on a plan is covered, not one feature's schema.
 * Answers that are not one JSON value pass through untouched for the SDK to
 * report. Streaming calls are not rewritten.
 */
export function createChatGptPlanStructuredOutputMiddleware(): LanguageModelMiddleware {
	return {
		specificationVersion: "v4",
		wrapGenerate: async ({ doGenerate, params }) => {
			const result = await doGenerate();
			const format = params.responseFormat;
			if (format?.type !== "json" || !isObject(format.schema)) {
				return result;
			}
			const textParts = result.content.filter(
				(part) => part.type === "text",
			);
			if (textParts.length === 0) {
				return result;
			}
			const text = textParts.map((part) => part.text).join("");
			let parsed: unknown;
			try {
				parsed = JSON.parse(text);
			} catch {
				return result;
			}
			const repaired = JSON.stringify(
				dropDisallowedNulls(parsed, format.schema),
			);
			if (repaired === JSON.stringify(parsed)) {
				return result;
			}
			const [first] = textParts;
			const content: typeof result.content = [];
			for (const part of result.content) {
				if (part.type !== "text") {
					content.push(part);
				} else if (part === first) {
					content.push({ ...part, text: repaired });
				}
			}
			return { ...result, content };
		},
	};
}
