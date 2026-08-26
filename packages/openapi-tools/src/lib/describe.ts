/**
 * OpenAPI/Swagger documentation extractor.
 *
 * Turns a spec document into a description of the API's contract — endpoints,
 * models, inputs, outputs and status codes — for feeding to a model as context.
 *
 * Runs beside `parser.ts` rather than replacing it. That module builds callable
 * tools for the API agent and is unchanged; see `describe-types.ts` for why the
 * two output shapes cannot be merged.
 *
 * Supports OpenAPI 3.0, 3.1 and Swagger 2.0. The 2.0 support is deliberate: the
 * driving use case is describing a legacy system to integrate against, and 2.0
 * is what legacy systems publish.
 */

import { load as loadYaml, YAMLException } from "js-yaml";
import type {
	ModelDescription,
	ModelPropertyDescription,
	OpenApiDescription,
	OperationDescription,
	ParameterDescription,
	ParameterLocation,
	RequestBodyDescription,
	ResponseDescription,
	SecuritySchemeSummary,
	SpecDetection,
} from "../describe-types";
import { OpenApiDescribeError } from "../describe-types";

const HTTP_METHODS = [
	"get",
	"post",
	"put",
	"delete",
	"patch",
	"options",
	"head",
	// Valid in OpenAPI 3.x. Omitting it drops those operations with no warning.
	"trace",
] as const;

/** How many properties of one model are described before the rest are counted. */
const MAX_MODEL_PROPERTIES = 60;

/** How many enum values are listed before the rest are counted. */
const MAX_ENUM_VALUES = 12;

/**
 * Depth ceiling for walking an inline schema.
 *
 * YAML anchors are the reason this is not optional: `js-yaml` resolves an anchor
 * into a genuinely cyclic object graph, so `items: *self` is a real cycle rather
 * than an inert `$ref`. Without a ceiling that recurses until the stack dies —
 * and on the ingestion path a stack overflow surfaces as a *successful* job with
 * nothing indexed. Deeply nested `allOf` chains hit the same wall without any
 * cycle at all.
 */
const MAX_SCHEMA_DEPTH = 12;

type Dict = Record<string, unknown>;

function isDict(value: unknown): value is Dict {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | null {
	return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Parse spec text as JSON, then YAML.
 *
 * JSON first because it is the cheaper parse and the common case; js-yaml would
 * accept most JSON anyway (JSON is a YAML subset), but not all of it — YAML 1.2
 * rejects duplicate keys that `JSON.parse` tolerates.
 */
function parseDocument(content: string): Dict {
	const trimmed = content.trim();
	if (trimmed.length === 0) {
		throw new OpenApiDescribeError("The document is empty.");
	}

	let jsonError: unknown;
	try {
		const parsed = JSON.parse(trimmed);
		if (isDict(parsed)) {
			return parsed;
		}
		throw new OpenApiDescribeError(
			"The document is valid JSON but not an object.",
		);
	} catch (error) {
		if (error instanceof OpenApiDescribeError) {
			throw error;
		}
		jsonError = error;
	}

	try {
		const parsed = loadYaml(trimmed);
		if (isDict(parsed)) {
			return parsed;
		}
		throw new OpenApiDescribeError(
			"The document is valid YAML but not an object.",
		);
	} catch (error) {
		if (error instanceof OpenApiDescribeError) {
			throw error;
		}
		// Report the YAML failure rather than the JSON one: a spec that is
		// neither is far more often malformed YAML than malformed JSON, and the
		// YAML parser's message carries a line number.
		const reason =
			error instanceof YAMLException
				? error.message
				: error instanceof Error
					? error.message
					: String(jsonError);
		throw new OpenApiDescribeError(
			`Could not parse as JSON or YAML: ${reason}`,
		);
	}
}

/**
 * Read a version field that YAML may have handed us as a number.
 *
 * `swagger: 2.0` and `openapi: 3.0` unquoted are ordinary YAML — and extremely
 * common in hand-written specs, since nothing about them looks like a string.
 * YAML parses both as numbers, and `String(2.0)` is `"2"`, not `"2.0"`. Treating
 * that as the version means a valid Swagger 2.0 file reads as version "2",
 * matches no supported prefix, and is reported as malformed — turning the exact
 * legacy document this feature exists to read into a hard ingestion failure.
 *
 * So a whole number is normalised back to its `major.0` form.
 */
function readVersionField(value: unknown): string | null {
	const asText = asString(value);
	if (asText) {
		return asText;
	}
	if (typeof value === "number" && Number.isFinite(value)) {
		return Number.isInteger(value) ? `${value}.0` : String(value);
	}
	return null;
}

/** The document's self-declared version, or null if it declares none. */
function readSpecVersion(doc: Dict): string | null {
	return readVersionField(doc.openapi) ?? readVersionField(doc.swagger);
}

function isSwagger2(specVersion: string): boolean {
	return specVersion.startsWith("2.");
}

/**
 * Decide whether some text is an OpenAPI document, without fully describing it.
 *
 * Cheap enough to run on every candidate upload. The three outcomes are what
 * keep "not a spec" silent and "broken spec" loud.
 */
export function looksLikeOpenApiSpec(content: string): SpecDetection {
	let doc: Dict;
	try {
		doc = parseDocument(content);
	} catch {
		// Unparseable text is not evidence of a broken spec — it is far more
		// likely not a spec at all. Only a document that parses AND declares a
		// version can be called malformed.
		return { kind: "not-a-spec" };
	}

	const specVersion = readSpecVersion(doc);
	if (!specVersion) {
		return { kind: "not-a-spec" };
	}

	if (!isDict(doc.info)) {
		return {
			kind: "malformed",
			reason: `Declares "${specVersion}" but has no "info" section.`,
		};
	}

	const hasPaths = isDict(doc.paths);
	const hasWebhooks = isDict(doc.webhooks);
	if (!hasPaths && !hasWebhooks) {
		return {
			kind: "malformed",
			reason: `Declares "${specVersion}" but has no "paths" section.`,
		};
	}

	if (!isSwagger2(specVersion) && !specVersion.startsWith("3.")) {
		return {
			kind: "malformed",
			reason: `Unsupported version "${specVersion}". Supported: OpenAPI 3.x and Swagger 2.0.`,
		};
	}

	return { kind: "spec", specVersion };
}

/** Model name from a local `$ref`, e.g. "#/components/schemas/Pet" -> "Pet". */
function refName(ref: string): string {
	const segments = ref.split("/");
	return segments[segments.length - 1] || ref;
}

/**
 * Shared parameter definitions, by name.
 *
 * 3.x keeps them under `components.parameters`, 2.0 under a top-level
 * `parameters`. Resolved rather than skipped — see `describeParameters`.
 */
function collectSharedParameters(
	doc: Dict,
	swagger2: boolean,
): Record<string, Dict> {
	const source = swagger2
		? doc.parameters
		: isDict(doc.components)
			? doc.components.parameters
			: undefined;
	if (!isDict(source)) {
		return {};
	}
	const map: Record<string, Dict> = {};
	for (const [name, node] of Object.entries(source)) {
		if (isDict(node)) {
			map[name] = node;
		}
	}
	return map;
}

/** Shared path-item definitions (3.1 `components.pathItems`), by name. */
function collectSharedPathItems(doc: Dict): Record<string, Dict> {
	const source = isDict(doc.components)
		? doc.components.pathItems
		: undefined;
	if (!isDict(source)) {
		return {};
	}
	const map: Record<string, Dict> = {};
	for (const [name, node] of Object.entries(source)) {
		if (isDict(node)) {
			map[name] = node;
		}
	}
	return map;
}

function schemaRefOf(schema: unknown): string | null {
	if (!isDict(schema)) {
		return null;
	}
	const ref = asString(schema.$ref);
	if (ref) {
		return refName(ref);
	}
	// An array of refs is common enough to be worth naming: `Pet[]` reads better
	// than "no reference" for a list endpoint, which is most list endpoints.
	if (schema.type === "array" && isDict(schema.items)) {
		const itemRef = asString(schema.items.$ref);
		if (itemRef) {
			return `${refName(itemRef)}[]`;
		}
	}
	return null;
}

/** Human-readable type for a schema node, without expanding it. */
function typeOf(schema: unknown, depth = 0): string {
	if (!isDict(schema)) {
		return "unknown";
	}
	// See MAX_SCHEMA_DEPTH: a YAML anchor makes a real object cycle, and an
	// unguarded walk dies on the stack rather than returning something partial.
	if (depth >= MAX_SCHEMA_DEPTH) {
		return "…";
	}
	const ref = schemaRefOf(schema);
	if (ref) {
		return ref;
	}
	for (const combinator of ["oneOf", "anyOf", "allOf"] as const) {
		const branch = schema[combinator];
		if (Array.isArray(branch)) {
			const names = branch.map((entry) => typeOf(entry, depth + 1));
			return names.join(combinator === "allOf" ? " & " : " | ");
		}
	}
	const format = asString(schema.format);
	const rawType = schema.type;
	const type = Array.isArray(rawType)
		? rawType.filter((entry) => typeof entry === "string").join(" | ")
		: asString(rawType);

	if (type === "array") {
		return `${typeOf(schema.items, depth + 1)}[]`;
	}
	if (type && format) {
		return `${type}<${format}>`;
	}
	return type || (isDict(schema.properties) ? "object" : "unknown");
}

function enumValuesOf(schema: unknown): string[] | undefined {
	if (!isDict(schema) || !Array.isArray(schema.enum)) {
		return undefined;
	}
	const values = schema.enum.map((entry) => String(entry));
	if (values.length <= MAX_ENUM_VALUES) {
		return values;
	}
	return [
		...values.slice(0, MAX_ENUM_VALUES),
		`… ${values.length - MAX_ENUM_VALUES} more`,
	];
}

/**
 * One-line shape for an inline (non-`$ref`) schema.
 *
 * Intentionally shallow: nested objects render as `{…}` rather than recursing.
 * A retrieved operation chunk needs to convey the shape, not reproduce it — and
 * the named models are indexed separately anyway.
 */
function summarizeSchema(schema: unknown): string | null {
	if (!isDict(schema)) {
		return null;
	}
	if (isDict(schema.properties)) {
		const required = new Set(
			Array.isArray(schema.required)
				? schema.required.filter(
						(entry): entry is string => typeof entry === "string",
					)
				: [],
		);
		const fields = Object.entries(schema.properties).map(([name, node]) => {
			const optional = required.has(name) ? "" : "?";
			return `${name}${optional}: ${typeOf(node)}`;
		});
		return `{ ${fields.join(", ")} }`;
	}
	const type = typeOf(schema);
	return type === "unknown" ? null : type;
}

/**
 * Media types and schema for a content map (3.x) or a produces/consumes list (2.0).
 */
function readContent(content: unknown): {
	contentTypes: string[];
	schema: unknown;
} {
	if (!isDict(content)) {
		return { contentTypes: [], schema: undefined };
	}
	const contentTypes = Object.keys(content);
	// Prefer JSON when present — it is what a schema most likely describes.
	const preferred =
		(isDict(content["application/json"])
			? content["application/json"]
			: undefined) ?? Object.values(content).find(isDict);
	return {
		contentTypes,
		schema: isDict(preferred) ? preferred.schema : undefined,
	};
}

function describeParameters(
	parameters: unknown,
	swagger2: boolean,
	sharedParameters: Record<string, Dict>,
): {
	parameters: ParameterDescription[];
	bodyParameter: Dict | null;
} {
	const described: ParameterDescription[] = [];
	let bodyParameter: Dict | null = null;

	if (!Array.isArray(parameters)) {
		return { parameters: described, bodyParameter };
	}

	for (const rawEntry of parameters) {
		if (!isDict(rawEntry)) {
			continue;
		}

		// Shared parameters ARE resolved, unlike schemas. A `$ref` to
		// `components/parameters` is a single local lookup, and getting it wrong
		// is worse than dropping it: reporting a required *path* parameter as an
		// optional *query* one hands the model a confident falsehood about how to
		// call the endpoint. Schemas stay unresolved because inlining them is
		// what bloats the output; one parameter costs nothing.
		const ref = asString(rawEntry.$ref);
		const resolved = ref ? sharedParameters[refName(ref)] : undefined;
		if (ref && !resolved) {
			// An external or unresolvable ref. Name it and say so, rather than
			// inventing a location and a requiredness for it.
			described.push({
				name: refName(ref),
				in: "query",
				required: false,
				type: "(shared parameter — definition not in this file)",
				description: null,
			});
			continue;
		}
		const entry = resolved ?? rawEntry;

		const location = asString(entry.in);

		// Swagger 2.0 carries the request body as a parameter with `in: body`.
		if (swagger2 && location === "body") {
			bodyParameter = entry;
			continue;
		}
		// 2.0 form uploads; described as parameters, which is close enough.
		if (location === "formData") {
			described.push({
				name: asString(entry.name) ?? "(unnamed)",
				in: "query",
				required: entry.required === true,
				type: swagger2 ? typeOf(entry) : typeOf(entry.schema),
				description: asString(entry.description),
			});
			continue;
		}

		if (
			location !== "path" &&
			location !== "query" &&
			location !== "header" &&
			location !== "cookie"
		) {
			continue;
		}

		// 2.0 puts type/format directly on the parameter; 3.x nests a schema.
		const schemaNode = swagger2 ? entry : entry.schema;
		described.push({
			name: asString(entry.name) ?? "(unnamed)",
			in: location as ParameterLocation,
			// Path parameters are required by definition in both versions.
			required: location === "path" ? true : entry.required === true,
			type: typeOf(schemaNode),
			description: asString(entry.description),
			enumValues: enumValuesOf(schemaNode),
		});
	}

	return { parameters: described, bodyParameter };
}

function describeRequestBody(
	operation: Dict,
	bodyParameter: Dict | null,
	swagger2: boolean,
	operationConsumes: string[],
): RequestBodyDescription | null {
	if (swagger2) {
		if (!bodyParameter) {
			return null;
		}
		const schema = bodyParameter.schema;
		return {
			required: bodyParameter.required === true,
			description: asString(bodyParameter.description),
			contentTypes: operationConsumes,
			schemaRef: schemaRefOf(schema),
			schemaSummary: schemaRefOf(schema) ? null : summarizeSchema(schema),
		};
	}

	const requestBody = operation.requestBody;
	if (!isDict(requestBody)) {
		return null;
	}
	const ref = asString(requestBody.$ref);
	if (ref) {
		return {
			required: false,
			description: null,
			contentTypes: [],
			schemaRef: refName(ref),
			schemaSummary: null,
		};
	}
	const { contentTypes, schema } = readContent(requestBody.content);
	const schemaRef = schemaRefOf(schema);
	return {
		required: requestBody.required === true,
		description: asString(requestBody.description),
		contentTypes,
		schemaRef,
		schemaSummary: schemaRef ? null : summarizeSchema(schema),
	};
}

/**
 * Every declared response, keyed by status code.
 *
 * The whole reason this module exists: the execution parser keeps 200 (or 201,
 * or `default`) and discards the rest, so an integrator asking "what does a 409
 * mean here" gets nothing.
 */
function describeResponses(
	responses: unknown,
	swagger2: boolean,
	operationProduces: string[],
): ResponseDescription[] {
	if (!isDict(responses)) {
		return [];
	}

	const described: ResponseDescription[] = [];
	for (const [statusCode, node] of Object.entries(responses)) {
		if (!isDict(node)) {
			continue;
		}
		const ref = asString(node.$ref);
		if (ref) {
			described.push({
				statusCode,
				description: null,
				contentTypes: [],
				schemaRef: refName(ref),
				schemaSummary: null,
			});
			continue;
		}

		// 2.0 puts the schema directly on the response and the media types on
		// the operation; 3.x nests both under `content`.
		const { contentTypes, schema } = swagger2
			? { contentTypes: operationProduces, schema: node.schema }
			: readContent(node.content);
		const schemaRef = schemaRefOf(schema);
		described.push({
			statusCode,
			description: asString(node.description),
			contentTypes,
			schemaRef,
			schemaSummary: schemaRef ? null : summarizeSchema(schema),
		});
	}

	// Numeric order, with `default` last, so a rendered chunk reads 200, 400,
	// 404, default rather than in object-key order.
	return described.sort((a, b) => {
		const left = Number.parseInt(a.statusCode, 10);
		const right = Number.parseInt(b.statusCode, 10);
		if (Number.isNaN(left)) {
			return Number.isNaN(right)
				? a.statusCode.localeCompare(b.statusCode)
				: 1;
		}
		if (Number.isNaN(right)) {
			return -1;
		}
		return left - right;
	});
}

/** Names of the security schemes a requirement list references. */
function describeSecurity(security: unknown): string[] {
	if (!Array.isArray(security)) {
		return [];
	}
	const names = new Set<string>();
	for (const entry of security) {
		if (isDict(entry)) {
			for (const name of Object.keys(entry)) {
				names.add(name);
			}
		}
	}
	return [...names];
}

function generateOperationId(method: string, path: string): string {
	const segments = path
		.split("/")
		.filter(Boolean)
		.map((segment) => {
			const isParam = segment.startsWith("{") && segment.endsWith("}");
			const cleaned = isParam ? segment.slice(1, -1) : segment;
			const safe = cleaned.replace(/[^a-zA-Z0-9]/g, "");
			return safe.charAt(0).toUpperCase() + safe.slice(1);
		});
	return method.toLowerCase() + segments.join("");
}

function stringList(value: unknown): string[] {
	return Array.isArray(value)
		? value.filter((entry): entry is string => typeof entry === "string")
		: [];
}

function describeOperations(
	doc: Dict,
	swagger2: boolean,
): { operations: OperationDescription[]; unresolvedPaths: string[] } {
	// 3.1 lets a document describe webhooks with no `paths` at all. Reading only
	// `paths` would report "Endpoints (0)" for a document full of them.
	const paths = {
		...(isDict(doc.paths) ? doc.paths : {}),
		...(isDict(doc.webhooks) ? doc.webhooks : {}),
	};
	const documentConsumes = stringList(doc.consumes);
	const documentProduces = stringList(doc.produces);
	const documentSecurity = describeSecurity(doc.security);
	const sharedParameters = collectSharedParameters(doc, swagger2);
	const pathItems = collectSharedPathItems(doc);

	const operations: OperationDescription[] = [];
	const unresolvedPaths: string[] = [];

	for (const [path, rawPathItem] of Object.entries(paths)) {
		if (!isDict(rawPathItem)) {
			continue;
		}
		// A whole path can be a `$ref` — routine in multi-file 2.0 specs and legal
		// in 3.x via `components.pathItems`. Following it locally costs one lookup;
		// not following it drops every operation on that path from both the
		// per-operation chunks and the endpoint inventory, silently.
		const pathRef = asString(rawPathItem.$ref);
		const pathItem = pathRef ? pathItems[refName(pathRef)] : rawPathItem;
		if (!pathItem) {
			// An external file we cannot open. Say the path exists rather than
			// letting it vanish from the inventory.
			unresolvedPaths.push(path);
			continue;
		}
		// Parameters declared once for every method on the path.
		const shared = describeParameters(
			pathItem.parameters,
			swagger2,
			sharedParameters,
		);

		for (const method of HTTP_METHODS) {
			const operation = pathItem[method];
			if (!isDict(operation)) {
				continue;
			}

			const own = describeParameters(
				operation.parameters,
				swagger2,
				sharedParameters,
			);
			// Operation-level parameters override path-level ones of the same
			// name and location, per both specs.
			const ownKeys = new Set(
				own.parameters.map((p) => `${p.in}:${p.name}`),
			);
			const parameters = [
				...shared.parameters.filter(
					(p) => !ownKeys.has(`${p.in}:${p.name}`),
				),
				...own.parameters,
			];

			const consumes = stringList(operation.consumes);
			const produces = stringList(operation.produces);
			const operationSecurity = describeSecurity(operation.security);

			operations.push({
				operationId:
					asString(operation.operationId) ??
					generateOperationId(method, path),
				method: method.toUpperCase(),
				path,
				summary: asString(operation.summary),
				description: asString(operation.description),
				tags: stringList(operation.tags),
				deprecated: operation.deprecated === true,
				parameters,
				requestBody: describeRequestBody(
					operation,
					own.bodyParameter ?? shared.bodyParameter,
					swagger2,
					consumes.length > 0 ? consumes : documentConsumes,
				),
				responses: describeResponses(
					operation.responses,
					swagger2,
					produces.length > 0 ? produces : documentProduces,
				),
				// An operation with no `security` key inherits the document's;
				// an explicit empty array means "no auth" and must not inherit.
				security:
					operation.security === undefined
						? documentSecurity
						: operationSecurity,
			});
		}
	}

	return { operations, unresolvedPaths };
}

function describeModels(doc: Dict, swagger2: boolean): ModelDescription[] {
	const source = swagger2
		? doc.definitions
		: isDict(doc.components)
			? doc.components.schemas
			: undefined;

	if (!isDict(source)) {
		return [];
	}

	const models: ModelDescription[] = [];
	for (const [name, node] of Object.entries(source)) {
		if (!isDict(node)) {
			continue;
		}
		const required = new Set(stringList(node.required));
		const properties: ModelPropertyDescription[] = [];

		if (isDict(node.properties)) {
			const entries = Object.entries(node.properties);
			for (const [propertyName, propertyNode] of entries.slice(
				0,
				MAX_MODEL_PROPERTIES,
			)) {
				properties.push({
					name: propertyName,
					type: typeOf(propertyNode),
					required: required.has(propertyName),
					description: isDict(propertyNode)
						? asString(propertyNode.description)
						: null,
					enumValues: enumValuesOf(propertyNode),
				});
			}
			if (entries.length > MAX_MODEL_PROPERTIES) {
				properties.push({
					name: `… ${entries.length - MAX_MODEL_PROPERTIES} more properties`,
					type: "",
					required: false,
					description: null,
				});
			}
		}

		models.push({
			name,
			description: asString(node.description),
			properties,
		});
	}

	return models;
}

function describeSecuritySchemes(
	doc: Dict,
	swagger2: boolean,
): SecuritySchemeSummary[] {
	const source = swagger2
		? doc.securityDefinitions
		: isDict(doc.components)
			? doc.components.securitySchemes
			: undefined;

	if (!isDict(source)) {
		return [];
	}

	const schemes: SecuritySchemeSummary[] = [];
	for (const [name, node] of Object.entries(source)) {
		if (!isDict(node)) {
			continue;
		}
		schemes.push({
			name,
			type: asString(node.type) ?? "unknown",
			in: asString(node.in) ?? undefined,
			scheme: asString(node.scheme) ?? undefined,
		});
	}
	return schemes;
}

/**
 * Server URLs. Swagger 2.0 spreads these across three fields, so compose them.
 */
function describeServers(doc: Dict, swagger2: boolean): string[] {
	if (swagger2) {
		const host = asString(doc.host);
		const basePath = asString(doc.basePath) ?? "";
		const schemes = stringList(doc.schemes);
		if (!host) {
			return basePath ? [basePath] : [];
		}
		const protocols = schemes.length > 0 ? schemes : ["https"];
		return protocols.map((scheme) => `${scheme}://${host}${basePath}`);
	}

	if (!Array.isArray(doc.servers)) {
		return [];
	}
	const servers: string[] = [];
	for (const entry of doc.servers) {
		if (!isDict(entry)) {
			continue;
		}
		let url = asString(entry.url);
		if (!url) {
			continue;
		}
		// Substitute declared defaults so the URL is usable rather than a template.
		if (isDict(entry.variables)) {
			for (const [key, variable] of Object.entries(entry.variables)) {
				if (isDict(variable)) {
					const fallback = asString(variable.default);
					if (fallback) {
						url = url.split(`{${key}}`).join(fallback);
					}
				}
			}
		}
		servers.push(url);
	}
	return servers;
}

/**
 * Describe an OpenAPI/Swagger document supplied as JSON or YAML text.
 *
 * Throws `OpenApiDescribeError` when the text is not a spec, or is one it cannot
 * read. Callers that need to distinguish "not a spec" from "broken spec" without
 * paying for a full description should call `looksLikeOpenApiSpec` first.
 */
export function describeOpenApiSpec(content: string): OpenApiDescription {
	const doc = parseDocument(content);
	const specVersion = readSpecVersion(doc);

	if (!specVersion) {
		throw new OpenApiDescribeError(
			'No "openapi" or "swagger" version field — this is not an OpenAPI document.',
		);
	}
	const swagger2 = isSwagger2(specVersion);
	if (!swagger2 && !specVersion.startsWith("3.")) {
		throw new OpenApiDescribeError(
			`Unsupported version "${specVersion}". Supported: OpenAPI 3.x and Swagger 2.0.`,
		);
	}

	const info = isDict(doc.info) ? doc.info : {};
	const described = describeOperations(doc, swagger2);

	return {
		specVersion,
		title: asString(info.title) ?? "Untitled API",
		version: asString(info.version) ?? "unversioned",
		description: asString(info.description),
		servers: describeServers(doc, swagger2),
		securitySchemes: describeSecuritySchemes(doc, swagger2),
		operations: described.operations,
		models: describeModels(doc, swagger2),
		unresolvedPaths: described.unresolvedPaths,
	};
}
