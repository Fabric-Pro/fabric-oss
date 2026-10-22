import { createHash } from "node:crypto";
import type { LanguageModelMiddleware } from "ai";
import type { StructuredOutputCapability } from "./structured-output-capabilities";

type Schema = Record<string, unknown>;
const object = (value: unknown): value is Schema =>
	typeof value === "object" && value !== null && !Array.isArray(value);

function reference(ref: unknown, root: Schema): Schema | undefined {
	if (typeof ref !== "string" || (ref !== "#" && !ref.startsWith("#/"))) {
		return;
	}
	let value: unknown = root;
	for (const part of ref === "#" ? [] : ref.slice(2).split("/")) {
		const key = part.replace(/~1/g, "/").replace(/~0/g, "~");
		value =
			object(value) && Object.hasOwn(value, key) ? value[key] : undefined;
	}
	return object(value) ? value : undefined;
}

function allowsNull(
	schema: Schema,
	root: Schema,
	seen = new Set<Schema>(),
): boolean {
	if (seen.has(schema)) {
		return true;
	}
	const visited = new Set(seen).add(schema);
	if (schema.const !== undefined && schema.const !== null) {
		return false;
	}
	if (Array.isArray(schema.enum) && !schema.enum.includes(null)) {
		return false;
	}
	if (
		schema.type !== undefined &&
		schema.type !== "null" &&
		!(Array.isArray(schema.type) && schema.type.includes("null"))
	) {
		return false;
	}
	if (schema.$ref !== undefined) {
		const target = reference(schema.$ref, root);
		if (!target || !allowsNull(target, root, visited)) {
			return false;
		}
	}
	for (const key of ["anyOf", "oneOf", "allOf"]) {
		const branches = schema[key];
		if (!Array.isArray(branches)) {
			continue;
		}
		const accepted = branches.filter(
			(branch) => object(branch) && allowsNull(branch, root, visited),
		).length;
		if (
			key === "allOf"
				? accepted !== branches.length
				: key === "oneOf"
					? accepted !== 1
					: accepted === 0
		) {
			return false;
		}
	}
	return true;
}

/** oneOf -> anyOf is equivalent when a required literal discriminator separates branches. */
function disjoint(branches: unknown[]): boolean {
	if (!branches.every(object)) {
		return false;
	}
	const first = branches[0];
	if (!first || !object(first.properties)) {
		return false;
	}
	return Object.keys(first.properties).some((key) => {
		const values = branches.map((branch) => {
			const properties = branch.properties;
			const field = object(properties) ? properties[key] : undefined;
			return Array.isArray(branch.required) &&
				branch.required.includes(key) &&
				object(field) &&
				typeof field.const === "string"
				? field.const
				: undefined;
		});
		return (
			values.every((value) => value !== undefined) &&
			new Set(values).size === branches.length
		);
	});
}

/**
 * Conversion preserves structural constraints. The caller's original Zod schema
 * validates unsupported value bounds and applies defaults after optional-null repair.
 * Unsupported structural keywords still cause a non-strict fallback.
 */
const VALUE_KEYWORDS = new Set([
	"default",
	"examples",
	"minLength",
	"maxLength",
	"uniqueItems",
	"$schema",
	"title",
]);

const KEYWORDS = new Set([
	"$schema",
	"$ref",
	"$defs",
	"definitions",
	"type",
	"properties",
	"required",
	"additionalProperties",
	"items",
	"anyOf",
	"oneOf",
	"allOf",
	"enum",
	"const",
	"description",
	"title",
]);

const SUPPORTED_FORMATS = new Set([
	"date-time",
	"time",
	"date",
	"duration",
	"email",
	"hostname",
	"ipv4",
	"ipv6",
	"uuid",
]);
const SUPPORTED_VALUE_KEYWORDS = new Set([
	"pattern",
	"format",
	"minimum",
	"maximum",
	"exclusiveMinimum",
	"exclusiveMaximum",
	"multipleOf",
	"minItems",
	"maxItems",
]);

function convert(
	schema: unknown,
	root: Schema,
	checkOnly = false,
): Schema | undefined {
	if (
		!object(schema) ||
		Object.keys(schema).some(
			(key) =>
				!KEYWORDS.has(key) &&
				!VALUE_KEYWORDS.has(key) &&
				!SUPPORTED_VALUE_KEYWORDS.has(key),
		)
	) {
		return;
	}
	if (
		checkOnly &&
		(Object.keys(schema).some((key) => VALUE_KEYWORDS.has(key)) ||
			(schema.format !== undefined &&
				!SUPPORTED_FORMATS.has(String(schema.format))))
	) {
		return;
	}
	if (
		schema.additionalProperties !== undefined &&
		schema.additionalProperties !== false
	) {
		return;
	}
	if (schema.$ref !== undefined && !reference(schema.$ref, root)) {
		return;
	}
	const types = Array.isArray(schema.type)
		? schema.type
		: schema.type === undefined
			? []
			: [schema.type];
	if (
		types.some(
			(type) =>
				![
					"object",
					"array",
					"string",
					"number",
					"integer",
					"boolean",
					"null",
				].includes(type),
		)
	) {
		return;
	}
	if (
		schema.required !== undefined &&
		(!Array.isArray(schema.required) ||
			schema.required.some(
				(key) =>
					typeof key !== "string" ||
					!object(schema.properties) ||
					!Object.hasOwn(schema.properties, key),
			))
	) {
		return;
	}
	if (schema.oneOf !== undefined && schema.anyOf !== undefined) {
		return;
	}
	const next: Schema = Object.fromEntries(
		Object.entries(schema).filter(([key]) => !VALUE_KEYWORDS.has(key)),
	);
	if (
		next.format !== undefined &&
		!SUPPORTED_FORMATS.has(String(next.format))
	) {
		delete next.format;
	}
	if (!checkOnly) {
		const hints = [
			typeof schema.minLength === "number"
				? `at least ${schema.minLength} character${schema.minLength === 1 ? "" : "s"}`
				: undefined,
			typeof schema.maxLength === "number"
				? `at most ${schema.maxLength} character${schema.maxLength === 1 ? "" : "s"}`
				: undefined,
		].filter(Boolean);
		if (hints.length) {
			next.description = [schema.description, `(${hints.join("; ")})`]
				.filter(Boolean)
				.join(" ");
		}
	}
	for (const key of ["properties", "$defs", "definitions"]) {
		if (schema[key] === undefined) {
			continue;
		}
		if (!object(schema[key])) {
			return;
		}
		const entries: [string, Schema][] = [];
		for (const [name, child] of Object.entries(schema[key])) {
			const converted = convert(child, root, checkOnly);
			if (!converted) {
				return;
			}
			entries.push([name, converted]);
		}
		next[key] = Object.fromEntries(entries);
	}
	if (schema.items !== undefined) {
		const items = convert(schema.items, root, checkOnly);
		if (!items) {
			return;
		}
		next.items = items;
	}
	for (const key of ["anyOf", "oneOf", "allOf"]) {
		const branches = schema[key];
		if (branches === undefined) {
			continue;
		}
		if (!Array.isArray(branches) || branches.length === 0) {
			return;
		}
		if (checkOnly && key !== "anyOf") {
			return;
		}
		if (key === "oneOf" && !disjoint(branches)) {
			return;
		}
		if (
			key === "allOf" &&
			!(
				branches.length === 1 &&
				object(branches[0]) &&
				Object.keys(branches[0]).length === 1 &&
				branches[0].$ref
			)
		) {
			return;
		}
		const converted = branches.map((branch) =>
			convert(branch, root, checkOnly),
		);
		if (converted.some((branch) => !branch)) {
			return;
		}
		if (key === "oneOf") {
			delete next.oneOf;
			next.anyOf = converted;
		} else if (key === "allOf") {
			// A reference replaces the annotation wrapper; structural siblings need intersection semantics.
			if (
				Object.keys(next).some(
					(key) => key !== "allOf" && key !== "description",
				)
			) {
				return;
			}
			delete next.allOf;
			delete next.description;
			next.$ref = (converted[0] as Schema).$ref;
		} else {
			next[key] = converted;
		}
	}
	if (
		schema.type === "object" ||
		(Array.isArray(schema.type) && schema.type.includes("object"))
	) {
		const properties = object(next.properties) ? next.properties : {};
		const required = Array.isArray(schema.required) ? schema.required : [];
		if (
			checkOnly &&
			(schema.additionalProperties !== false ||
				Object.keys(properties).some((key) => !required.includes(key)))
		) {
			return;
		}

		for (const [name, child] of Object.entries(properties)) {
			const original = object(schema.properties)
				? schema.properties[name]
				: undefined;
			if (
				!required.includes(name) &&
				object(original) &&
				!allowsNull(original, root)
			) {
				properties[name] = { anyOf: [child, { type: "null" }] };
			}
		}
		next.properties = properties;
		next.required = Object.keys(properties);
		next.additionalProperties = false;
	}
	// Unconstrained schemas (z.unknown / z.any) cannot be closed faithfully.
	if (
		schema.type === undefined &&
		schema.$ref === undefined &&
		schema.anyOf === undefined &&
		schema.oneOf === undefined &&
		schema.allOf === undefined &&
		schema.enum === undefined &&
		schema.const === undefined
	) {
		return;
	}
	return next;
}

function objectRoot(schema: unknown): schema is Schema {
	return (
		object(schema) &&
		schema.type === "object" &&
		schema.$ref === undefined &&
		schema.anyOf === undefined &&
		schema.oneOf === undefined &&
		schema.allOf === undefined
	);
}

/** Measure emitted nodes once for totals, and follow local refs for object depth.
 * Recursive refs stop at their active ancestor; OpenAI supports recursive schemas.
 */
export function strictJsonSchemaSize(schema: Schema): {
	objectDepth: number;
	properties: number;
	enumValues: number;
	stringLength: number;
} {
	let properties = 0;
	let enumValues = 0;
	let stringLength = 0;
	const children = (node: Schema): Schema[] => [
		...["properties", "$defs", "definitions"].flatMap((key) =>
			object(node[key]) ? Object.values(node[key]).filter(object) : [],
		),
		...(object(node.items) ? [node.items] : []),
		...(Array.isArray(node.anyOf) ? node.anyOf.filter(object) : []),
	];
	const totals = (node: Schema): void => {
		if (object(node.properties)) {
			const names = Object.keys(node.properties);
			properties += names.length;
			stringLength += names.reduce((n, name) => n + name.length, 0);
		}
		if (Array.isArray(node.enum)) {
			enumValues += node.enum.length;
			stringLength += node.enum.reduce(
				(n: number, value: unknown) =>
					n + (typeof value === "string" ? value.length : 0),
				0,
			);
		}
		if (typeof node.const === "string") {
			stringLength += node.const.length;
		}
		children(node).forEach(totals);
	};
	const depth = (node: Schema, active = new Set<Schema>()): number => {
		if (active.has(node)) {
			return 0;
		}
		const next = new Set(active).add(node);
		const target = reference(node.$ref, schema);
		return (
			(node.type === "object" ||
			(Array.isArray(node.type) && node.type.includes("object"))
				? 1
				: 0) +
			Math.max(
				0,
				...children(node).map((child) => depth(child, next)),
				...(target ? [depth(target, next)] : []),
			)
		);
	};
	totals(schema);
	return { objectDepth: depth(schema), properties, enumValues, stringLength };
}

function withinStrictLimits(schema: Schema): boolean {
	const size = strictJsonSchemaSize(schema);
	return (
		size.objectDepth <= 10 &&
		size.properties <= 5000 &&
		size.enumValues <= 1000 &&
		size.stringLength <= 120000
	);
}

/** Checks structure without changing the schema; used by conversion and fetch guards. */
export function isStrictJsonSchemaCompatible(schema: unknown): boolean {
	return (
		objectRoot(schema) &&
		convert(schema, schema, true) !== undefined &&
		withinStrictLimits(schema)
	);
}

/** Root arrays/unions are left non-strict; Output.array supplies its own object envelope. */
export function toStrictJsonSchema(schema: unknown): Schema | undefined {
	if (!objectRoot(schema)) {
		return;
	}
	const converted = convert(schema, schema);
	return isStrictJsonSchemaCompatible(converted) ? converted : undefined;
}

/** Preserve strict requests only when the shared structural checker accepts their schema. */
export function relaxIncompatibleStrictJsonSchema(body: Schema): boolean {
	const format = body.response_format;
	if (
		!object(format) ||
		format.type !== "json_schema" ||
		!object(format.json_schema)
	) {
		return false;
	}
	const jsonSchema = format.json_schema;
	if (
		jsonSchema.strict !== true ||
		isStrictJsonSchemaCompatible(jsonSchema.schema)
	) {
		return false;
	}
	jsonSchema.strict = false;
	return true;
}

/** Match branch identity, tolerating only the optional-null convention introduced above. */
function matches(
	value: unknown,
	schema: Schema,
	root: Schema,
	seen = new Set<Schema>(),
): boolean {
	if (seen.has(schema)) {
		return false;
	}
	const visited = new Set(seen).add(schema);
	if (schema.$ref !== undefined) {
		const target = reference(schema.$ref, root);
		if (!target || !matches(value, target, root, visited)) {
			return false;
		}
	}
	if (schema.const !== undefined && value !== schema.const) {
		return false;
	}
	if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
		return false;
	}
	const types = Array.isArray(schema.type)
		? schema.type
		: schema.type
			? [schema.type]
			: [];
	if (
		types.length &&
		!types.some((type) =>
			type === "null"
				? value === null
				: type === "array"
					? Array.isArray(value)
					: type === "object"
						? object(value)
						: type === "integer"
							? Number.isInteger(value)
							: typeof value === type,
		)
	) {
		return false;
	}
	for (const key of ["anyOf", "oneOf", "allOf"]) {
		if (Array.isArray(schema[key])) {
			const results = schema[key].map(
				(branch: unknown) =>
					object(branch) && matches(value, branch, root, visited),
			);
			if (
				key === "allOf"
					? !results.every(Boolean)
					: key === "oneOf"
						? results.filter(Boolean).length !== 1
						: !results.some(Boolean)
			) {
				return false;
			}
		}
	}
	if (object(value) && object(schema.properties)) {
		if (
			schema.additionalProperties === false &&
			Object.keys(value).some(
				(key) => !Object.hasOwn(schema.properties as Schema, key),
			)
		) {
			return false;
		}
		const required = Array.isArray(schema.required) ? schema.required : [];
		if (
			required.some(
				(key) => typeof key !== "string" || !Object.hasOwn(value, key),
			)
		) {
			return false;
		}
		for (const [key, field] of Object.entries(schema.properties)) {
			if (!Object.hasOwn(value, key) || !object(field)) {
				continue;
			}
			if (value[key] === null && !required.includes(key)) {
				continue;
			}
			if (!matches(value[key], field, root)) {
				return false;
			}
		}
	}
	return true;
}

function repair(
	input: unknown,
	schema: Schema,
	root: Schema,
	seen = new Set<Schema>(),
): unknown {
	let value = input;
	if (seen.has(schema)) {
		return value;
	}
	const visited = new Set(seen).add(schema);
	if (schema.$ref !== undefined) {
		const target = reference(schema.$ref, root);
		if (target) {
			value = repair(value, target, root, visited);
		}
	}
	for (const key of ["anyOf", "oneOf", "allOf"]) {
		if (!Array.isArray(schema[key])) {
			continue;
		}
		const branches = schema[key].filter(
			(branch: unknown): branch is Schema =>
				object(branch) && matches(value, branch, root),
		);
		const candidates = branches.map((branch) =>
			repair(value, branch, root, visited),
		);
		// Ambiguous union branches may disagree about nullability. Preserve the value.
		if (
			candidates.length &&
			candidates.every(
				(candidate) =>
					JSON.stringify(candidate) === JSON.stringify(candidates[0]),
			)
		) {
			value = candidates[0];
		}
	}
	if (Array.isArray(value) && object(schema.items)) {
		const items = schema.items;
		return value.map((item) => repair(item, items, root));
	}
	if (!object(value) || !object(schema.properties)) {
		return value;
	}
	const properties = schema.properties;
	const required = Array.isArray(schema.required) ? schema.required : [];
	return Object.fromEntries(
		Object.entries(value).flatMap(([key, field]) => {
			const child = properties[key];
			if (!Object.hasOwn(properties, key) || !object(child)) {
				return [[key, field]];
			}
			if (
				field === null &&
				!required.includes(key) &&
				!allowsNull(child, root)
			) {
				return [];
			}
			return [[key, repair(field, child, root)]];
		}),
	);
}

const STRICT_REJECTION_CACHE_MAX = 500;
const STRICT_REJECTION_TTL_MS = 60 * 60 * 1000;
const strictRejections = new Map<string, number>();

const STRICT_REJECTION_SUBJECT =
	/response[_ -]?format|json[_ -]?schema|structured[_ -]?outputs?|\bstrict(?:JsonSchema)?\b/i;
const STRICT_REJECTION_VERDICT =
	/\b(?:invalid|unsupported|not supported|(?:does|do) not support|not permitted|not allowed|reject(?:s|ed)?|requires?|must|unknown|unrecognized|not available)\b/i;

const ERROR_BODY_FIELDS = ["message", "msg", "detail", "loc", "param", "error"];
const ERROR_BODY_MAX_NODES = 1000;

/**
 * The provider-authored error text in a response body. A JSON body contributes
 * only its error fields, so echoed request content (a 422 body's `input`)
 * cannot satisfy the match with the strict request's own `response_format`.
 * Traversal is iterative and stops after 1000 nodes.
 */
function bodyErrorTexts(body: string): string[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(body);
	} catch {
		return [body];
	}
	const texts: string[] = [];
	const pending: unknown[] = [parsed];
	for (let visited = 0; pending.length > 0; visited++) {
		if (visited >= ERROR_BODY_MAX_NODES) {
			break;
		}
		const value = pending.pop();
		if (typeof value === "string") {
			texts.push(value);
		} else if (Array.isArray(value)) {
			// Enqueue only what the remaining budget can visit, one at a time:
			// spreading a very wide array into push() overflows the call stack.
			const budget = ERROR_BODY_MAX_NODES - visited - pending.length;
			for (
				let index = 0;
				index < value.length && index < budget;
				index++
			) {
				pending.push(value[index]);
			}
		} else if (object(value)) {
			for (const field of ERROR_BODY_FIELDS) {
				pending.push(value[field]);
			}
		}
	}
	return texts;
}

/**
 * The evidence for one link and its direct cause. When either carries a
 * response body, only the body's error fields count: client wrappers write
 * their own messages (the gateway's "Invalid error response format: ..." for
 * any body it cannot parse), and those must not read as a schema rejection.
 * Message text is used only when no body exists.
 */
function rejectionEvidenceOf(
	link: Record<string, unknown>,
	cause: unknown,
): string {
	const pair = object(cause) ? [link, cause] : [link];
	const bodies = pair
		.map(({ responseBody }) => responseBody)
		.filter((body): body is string => typeof body === "string");
	if (bodies.length > 0) {
		return bodies.flatMap(bodyErrorTexts).join(" ");
	}
	return pair
		.map(({ message }) => message)
		.filter((message): message is string => typeof message === "string")
		.join(" ");
}

/** Gateway wrappers carry the status while their causes carry the body.
 * Inspect at most 16 distinct links, using HTTP status and text rather than SDK
 * classes. A link qualifies only when its own status is 400/422 and the
 * rejection evidence is on that link or its direct cause, so an unrelated
 * nested error cannot lend its words to an outer 400.
 */
function isStrictRejection(error: unknown): boolean {
	// Classification must never replace the provider's error: anything it
	// cannot handle counts as "not a strict rejection" and the original error
	// propagates.
	try {
		return classifyStrictRejection(error);
	} catch {
		return false;
	}
}

function classifyStrictRejection(error: unknown): boolean {
	const seen = new Set<unknown>();
	let current = error;
	while (object(current) && !seen.has(current) && seen.size < 16) {
		seen.add(current);
		if (current.statusCode === 400 || current.statusCode === 422) {
			const text = rejectionEvidenceOf(current, current.cause);
			if (
				STRICT_REJECTION_SUBJECT.test(text) &&
				STRICT_REJECTION_VERDICT.test(text)
			) {
				return true;
			}
		}
		current = current.cause;
	}
	return false;
}

/**
 * Innermost factory middleware: conversion is scoped to generate requests that
 * this instance transformed. The WeakMap binds reply repair to those params,
 * including concurrent calls, without altering explicit caller choices.
 */
export function createStrictJsonSchemaMiddleware(
	capability: StructuredOutputCapability,
	provider?: string,
	endpointScope = "default",
): LanguageModelMiddleware {
	type Params = Parameters<
		NonNullable<LanguageModelMiddleware["transformParams"]>
	>[0]["params"];
	const originals = new WeakMap<
		Params,
		{ schema: Schema; params: Params; key: string }
	>();
	return {
		specificationVersion: "v4",
		transformParams: async ({ params, type, model }) => {
			if (params.responseFormat?.type !== "json") {
				return params;
			}
			const explicit = capability.namespaces.some(({ reads }) =>
				reads.some(
					(name) =>
						typeof params.providerOptions?.[name]
							?.strictJsonSchema === "boolean",
				),
			);
			const original = params.responseFormat.schema;
			let converted =
				!explicit && type === "generate" && capability.mode === "strict"
					? toStrictJsonSchema(original)
					: undefined;
			const key = converted
				? JSON.stringify([
						provider ?? model.provider,
						endpointScope,
						model.modelId,
						createHash("sha256")
							.update(JSON.stringify(converted))
							.digest("hex"),
					])
				: "";
			const expiresAt = strictRejections.get(key);
			if (expiresAt !== undefined) {
				if (Date.now() < expiresAt) {
					converted = undefined;
				} else {
					strictRejections.delete(key);
				}
			}
			const providerOptions = { ...params.providerOptions };
			let changed = false;
			for (const { write, reads } of capability.namespaces) {
				if (
					reads.some(
						(name) =>
							typeof params.providerOptions?.[name]
								?.strictJsonSchema === "boolean",
					)
				) {
					continue;
				}
				providerOptions[write] = {
					...providerOptions[write],
					strictJsonSchema: Boolean(converted) && write === "openai",
				};
				changed = true;
			}
			if (!changed) {
				return params;
			}
			const next: Params = {
				...params,
				providerOptions,
				...(converted && {
					responseFormat: {
						...params.responseFormat,
						schema: converted,
					},
				}),
			};
			if (converted && object(original)) {
				originals.set(next, { schema: original, params, key });
			}
			return next;
		},
		wrapGenerate: async ({ doGenerate, params, model }) => {
			const transformed = originals.get(params);
			let result: Awaited<ReturnType<typeof doGenerate>>;
			try {
				result = await doGenerate();
			} catch (error) {
				if (!transformed || !isStrictRejection(error)) {
					throw error;
				}
				if (!strictRejections.has(transformed.key)) {
					while (
						strictRejections.size >= STRICT_REJECTION_CACHE_MAX
					) {
						const oldest = strictRejections.keys().next();
						if (!oldest.done) {
							strictRejections.delete(oldest.value);
						}
					}
					strictRejections.set(
						transformed.key,
						Date.now() + STRICT_REJECTION_TTL_MS,
					);
					console.warn(
						`[AI] Strict structured output rejected; using non-strict. Provider: ${provider ?? model.provider}; model: ${model.modelId}`,
					);
				}
				const fallback = transformed.params;
				const providerOptions = { ...fallback.providerOptions };
				for (const { write } of capability.namespaces) {
					providerOptions[write] = {
						...providerOptions[write],
						strictJsonSchema: false,
					};
				}
				// Bypass this middleware once; the original schema and Zod validation remain in effect.
				return model.doGenerate({ ...fallback, providerOptions });
			}
			if (!transformed) {
				return result;
			}
			const original = transformed.schema;
			// ai 7.0.140 dist/index.js:4647,13136-13139,13696-13697 concatenate
			// text parts for Output.object / generateObject. The strict routes selected
			// by structuredOutputCapabilityFor (OpenAI chat/responses, Azure chat,
			// and gateway openai/ models) expose JSON output as text here.
			const textParts = result.content.filter(
				(part) => part.type === "text",
			);
			if (!textParts.length) {
				return result;
			}
			const joined = textParts.map((part) => part.text).join("");
			const prefix =
				joined.match(/^\s*<think>[\s\S]*?<\/think>\s*/)?.[0] ?? "";
			let parsed: unknown;
			try {
				parsed = JSON.parse(joined.slice(prefix.length));
			} catch {
				return result;
			}
			const text = JSON.stringify(repair(parsed, original, original));
			if (text === JSON.stringify(parsed)) {
				return result;
			}
			return {
				...result,
				content: result.content.map((part) =>
					part.type === "text"
						? {
								...part,
								text:
									part === textParts[0] ? prefix + text : "",
							}
						: part,
				),
			};
		},
	};
}
