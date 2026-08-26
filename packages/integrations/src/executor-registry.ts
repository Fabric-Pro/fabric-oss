/**
 * Integration Executor Registry
 *
 * One catalog of directly-executable workflow integrations: discovery metadata,
 * canonical READ/WRITE access, credential policy, argument schemas, and the
 * executor itself. Both Temporal execution paths — the LOOM chat
 * `integration__{PROVIDER}` dispatcher and the step-path IntegrationHandler —
 * resolve providers here, so each registered provider has exactly one
 * implementation and one operation list.
 *
 * Each operation declares ONE Zod schema. It is both the runtime validator and
 * the source of the JSON Schema advertised to the model — `inputSchema` is
 * derived from it via `z.toJSONSchema`, never hand-written alongside it, so the
 * two cannot drift.
 *
 * Runtime policy is deliberately NOT here: credential fetching, project
 * Read-only mode, and runtime authority stay in the Temporal adapter that calls
 * this registry. The registry only declares what an operation IS (access,
 * retry-safety, required credential keys, argument shape) so those gates can be
 * driven by a trusted classification instead of a tool-name heuristic.
 */

import type { WorkflowIntegrationProvider } from "@repo/database";
import { z } from "zod";
import {
	listDatabricksVectorIndexes,
	MAX_QUERY_INDEXES,
	queryDatabricksVectorIndexes,
} from "./databricks-vector-search";
import { executeNhtsaTool } from "./nhtsa";

// ─── Contract ────────────────────────────────────────────────────────────────

/**
 * What a provider needs from the tenant before an operation may run.
 *
 * `ACTIVE_CONFIGURATION` still requires a live, active integration row — a
 * credentialless public API must not stay executable after the tenant disables
 * or deletes the integration.
 */
export type CredentialPolicy =
	| { kind: "ACTIVE_CONFIGURATION"; secrets: "NONE" }
	| { kind: "WORKFLOW_INTEGRATION"; requiredKeys: readonly string[] };

export interface IntegrationExecutionContext {
	credentials?: Record<string, string>;
	/**
	 * Reserved for write-capable providers (none are registered yet). A
	 * provider declaring `REQUIRES_IDEMPOTENCY_KEY` must not be marked
	 * `chatEnabled` until the caller supplies this.
	 */
	idempotencyKey?: string;
	/**
	 * Cancels the in-flight provider call. Honored by NHTSA; the shared
	 * Databricks API client does not thread it to `fetch` yet, so a cancelled
	 * Databricks query still completes in the background.
	 */
	signal?: AbortSignal;
}

export interface IntegrationExecutionResult {
	/** Structured result — what the chat path returns to the model. */
	data: unknown;
	/** Human/LLM-readable rendering — what the step path returns as its response. */
	text: string;
}

export interface OperationDefinition {
	description: string;
	/** Natural-language cues used to resolve a step description to this operation. */
	keywords: readonly string[];
	/**
	 * JSON Schema advertised to the model. DERIVED from `schema` — do not set
	 * this by hand; that is the drift this registry exists to prevent.
	 */
	inputSchema: Record<string, unknown>;
	/** The Zod schema `inputSchema` and `parseArgs` both come from. */
	schema: z.ZodType;
	/** Canonical effect. Authority and Read-only mode use this, not the name. */
	access: "READ" | "WRITE";
	/** Whether the LOOM chat surface may discover and execute this operation. */
	chatEnabled: boolean;
	retrySafety:
		| "SAFE"
		| "REQUIRES_IDEMPOTENCY_KEY"
		| "DO_NOT_RETRY_AFTER_DISPATCH";
	/**
	 * Runtime enforcement of `schema`. Throws `ZodError` on anything the
	 * operation cannot honor — it never silently drops a malformed field,
	 * because dropping one widens the request instead of failing it. Operation
	 * schemas are strict for the same reason: a misspelled `indexNames` would
	 * otherwise be stripped, leaving no selection and searching every index.
	 */
	parseArgs(args: Record<string, unknown>): unknown;
	/**
	 * Runs the operation. `args` MUST be the output of `parseArgs` — always go
	 * through {@link executeRegisteredIntegrationOperation} rather than calling
	 * this directly.
	 */
	execute(
		args: unknown,
		context: IntegrationExecutionContext,
	): Promise<IntegrationExecutionResult>;
}

export interface IntegrationExecutorDefinition {
	description: string;
	capabilities: readonly string[];
	/** BM25-style provider match phrases used by integration discovery. */
	providerKeywords: readonly string[];
	credentialPolicy: CredentialPolicy;
	operations: Record<string, OperationDefinition>;
}

/** Thrown when supplied arguments do not satisfy an operation's declared schema. */
export class IntegrationArgumentError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "IntegrationArgumentError";
	}
}

/**
 * Render a schema as the JSON Schema advertised to the model.
 *
 * `io: "input"` is required, not incidental: several operations transform their
 * input (VIN batches, index-name sanitization), and the default "output" mode
 * refuses to represent transforms at all. Input mode is also the semantically
 * correct choice — we are telling the model what to SEND.
 *
 * `$schema` is stripped because the advertised schema is inlined into every
 * tool definition and the dialect declaration buys the model nothing.
 */
export function toAdvertisedJsonSchema(
	schema: z.ZodType,
): Record<string, unknown> {
	const { $schema: _dialect, ...rest } = z.toJSONSchema(schema, {
		io: "input",
	}) as Record<string, unknown>;
	return rest;
}

/**
 * Bind one operation's schema, executor and derived JSON Schema together, so
 * `parseArgs`, `execute` and `inputSchema` cannot disagree about the argument
 * shape.
 */
function defineOperation<TSchema extends z.ZodType>(spec: {
	description: string;
	keywords: readonly string[];
	schema: TSchema;
	access: "READ" | "WRITE";
	chatEnabled: boolean;
	retrySafety: OperationDefinition["retrySafety"];
	execute: (
		args: z.output<TSchema>,
		context: IntegrationExecutionContext,
	) => Promise<IntegrationExecutionResult>;
}): OperationDefinition {
	return {
		description: spec.description,
		keywords: spec.keywords,
		schema: spec.schema,
		inputSchema: toAdvertisedJsonSchema(spec.schema),
		access: spec.access,
		chatEnabled: spec.chatEnabled,
		retrySafety: spec.retrySafety,
		parseArgs: (args) => spec.schema.parse(args),
		execute: (args, context) =>
			spec.execute(args as z.output<TSchema>, context),
	};
}

// ─── Field schemas ───────────────────────────────────────────────────────────
//
// Messages name their own field so a validation failure reads as an
// instruction the model can act on, rather than a type error.

function requiredString(key: string, description: string) {
	const error = `"${key}" is required and must be a non-empty string`;
	return z
		.string({ error })
		.refine((value) => value.trim() !== "", { error })
		.describe(description);
}

function optionalString(key: string, description: string) {
	// null / "" mean "not supplied" rather than "supplied wrongly".
	return z
		.preprocess(
			(value) => (value === null || value === "" ? undefined : value),
			z.string({ error: `"${key}" must be a string` }).optional(),
		)
		.optional()
		.describe(description);
}

/**
 * Numbers, plus the quoted numbers models routinely emit. A non-numeric string
 * is passed through unchanged so the inner `z.number()` rejects it — coercing
 * it to NaN would turn a typo into a silent default. `z.number()` already
 * rejects booleans, null, NaN and Infinity.
 */
function optionalNumber(key: string, description: string) {
	return z
		.preprocess((value) => {
			if (value === undefined || value === null || value === "") {
				return undefined;
			}
			if (typeof value === "string") {
				const parsed = Number(value);
				return Number.isFinite(parsed) ? parsed : value;
			}
			return value;
		}, z.number({ error: `"${key}" must be a number` }).optional())
		.optional()
		.describe(description);
}

/** Year-like fields: a number or numeric string in, always a string out. */
function yearLike(key: string, description: string, required: boolean) {
	const error = required
		? `"${key}" is required and must be a string or number`
		: `"${key}" must be a string or number`;
	const coerce = (value: unknown) => {
		if (value === undefined || value === null || value === "") {
			return undefined;
		}
		return typeof value === "number" && Number.isFinite(value)
			? String(value)
			: value;
	};
	const pipe = z.preprocess(
		coerce,
		required ? z.string({ error }) : z.string({ error }).optional(),
	);
	// `.optional()` must sit OUTSIDE the pipe: optionality buried inside a
	// preprocess is invisible to the object's required-field detection, which
	// would advertise every optional field as mandatory.
	return required
		? pipe.describe(description)
		: pipe.optional().describe(description);
}

// ─── NHTSA VPIC ──────────────────────────────────────────────────────────────

/**
 * Build one NHTSA operation. The VPIC executor dispatches on method name, so
 * each registry entry closes over its own name.
 */
function buildNhtsaOperation<TSchema extends z.ZodType>(
	methodName: string,
	description: string,
	keywords: readonly string[],
	schema: TSchema,
): OperationDefinition {
	return defineOperation({
		description,
		keywords,
		schema,
		access: "READ",
		chatEnabled: true,
		retrySafety: "SAFE",
		execute: async (args, context) => {
			const data = await executeNhtsaTool(
				methodName,
				args as Record<string, unknown>,
				{ signal: context.signal },
			);
			return { data, text: JSON.stringify(data, null, 2) };
		},
	});
}

const NHTSA_OPERATIONS: Record<string, OperationDefinition> = {
	decode_vin: buildNhtsaOperation(
		"decode_vin",
		"Decode a Vehicle Identification Number (VIN)",
		[
			"decode vin",
			"vin decode",
			"vin lookup",
			"what car",
			"identify vehicle",
			"vehicle identification",
		],
		z.strictObject({
			vin: requiredString("vin", "The 17-character VIN to decode"),
			modelYear: yearLike(
				"modelYear",
				"Optional model year to disambiguate the decode",
				false,
			),
		}),
	),
	decode_vin_batch: buildNhtsaOperation(
		"decode_vin_batch",
		"Decode multiple VINs at once",
		["batch vin", "multiple vin", "bulk decode"],
		z.strictObject({
			// The VPIC batch endpoint's own wire format is semicolon-delimited,
			// so callers legitimately pass either shape.
			vins: z
				.union(
					[
						z
							.array(z.unknown())
							.meta({ items: { type: "string" } }),
						z.string(),
					],
					{
						error: '"vins" must be an array of VINs or a semicolon-delimited string',
					},
				)
				.transform((value) =>
					typeof value === "string"
						? value
								.split(";")
								.map((vin) => vin.trim())
								.filter(Boolean)
						: value.filter(
								(vin): vin is string =>
									typeof vin === "string" &&
									vin.trim() !== "",
							),
				)
				.refine((vins) => vins.length > 0, {
					error: '"vins" must contain at least one VIN',
				})
				.describe("Up to 50 VINs to decode in one request"),
		}),
	),
	decode_wmi: buildNhtsaOperation(
		"decode_wmi",
		"Decode a World Manufacturer Identifier",
		["wmi", "manufacturer identifier", "decode wmi"],
		z.strictObject({
			wmi: requiredString(
				"wmi",
				"3- or 6-character World Manufacturer Identifier",
			),
		}),
	),
	get_all_manufacturers: buildNhtsaOperation(
		"get_all_manufacturers",
		"List all vehicle manufacturers",
		["all manufacturers", "list manufacturers", "vehicle manufacturers"],
		z.strictObject({
			page: optionalNumber("page", "Page number for pagination"),
			manufacturerType: optionalString(
				"manufacturerType",
				"Filter by manufacturer type",
			),
		}),
	),
	get_manufacturer_details: buildNhtsaOperation(
		"get_manufacturer_details",
		"Get details about a specific manufacturer",
		["manufacturer details", "about manufacturer", "manufacturer info"],
		z.strictObject({
			manufacturer: requiredString(
				"manufacturer",
				"Manufacturer name or manufacturer ID",
			),
		}),
	),
	get_all_makes: buildNhtsaOperation(
		"get_all_makes",
		"List all vehicle makes",
		["all makes", "list makes", "vehicle makes"],
		z.strictObject({}),
	),
	get_models_for_make: buildNhtsaOperation(
		"get_models_for_make",
		"Get models for a vehicle make",
		["models for", "make models", "what models"],
		z.strictObject({
			make: requiredString("make", "Vehicle make, e.g. Toyota"),
		}),
	),
	get_models_for_make_year: buildNhtsaOperation(
		"get_models_for_make_year",
		"Get models for a make filtered by year",
		["models for year", "make year", "models by year"],
		z.strictObject({
			make: requiredString("make", "Vehicle make, e.g. Toyota"),
			year: yearLike("year", "Model year, e.g. 2020", true),
			vehicleType: optionalString(
				"vehicleType",
				"Optional vehicle type filter, e.g. truck",
			),
		}),
	),
	get_vehicle_types_for_make: buildNhtsaOperation(
		"get_vehicle_types_for_make",
		"Get vehicle types for a make",
		["vehicle types", "types for make", "what types"],
		z.strictObject({
			make: requiredString("make", "Vehicle make, e.g. Toyota"),
		}),
	),
};

// ─── Databricks Vector Search ────────────────────────────────────────────────

const DATABRICKS_CREDENTIAL_KEYS = [
	"DATABRICKS_HOST",
	"DATABRICKS_CLIENT_ID",
	"DATABRICKS_CLIENT_SECRET",
] as const;

/**
 * An explicit index selection must stay explicit. A non-array value (e.g. a
 * bare index-name string) is REJECTED rather than ignored — ignoring it would
 * silently widen the search to every index in the workspace. Unusable entries
 * inside a well-formed array are dropped, but emptying the array that way is
 * itself an error, for the same reason.
 */
const indexNamesSchema = z
	.array(z.unknown(), {
		error: '"indexNames" must be an array of fully-qualified index names',
	})
	.meta({ items: { type: "string" } })
	.transform((value) =>
		value.filter(
			(name): name is string => typeof name === "string" && name !== "",
		),
	)
	.refine((names) => names.length > 0, {
		error: '"indexNames" contained no usable index names',
	})
	.describe("Fully-qualified index names (catalog.schema.index) to search")
	.optional();

/**
 * `question` is the long-standing planner alias for `query`. It is normalized
 * away before validation rather than declared as a field, so the advertised
 * schema tells the model about `query` only.
 */
const queryIndexSchema = z.preprocess(
	(raw) => {
		if (raw && typeof raw === "object" && !Array.isArray(raw)) {
			const { question, ...args } = raw as Record<string, unknown>;
			// The alias is normalized away AND removed: the schema below is
			// strict, so leaving `question` in place would fail as an
			// unrecognized key.
			if (typeof question === "string") {
				return { ...args, query: args.query ?? question };
			}
		}
		return raw;
	},
	z.strictObject({
		query: z
			.string({ error: "query is required" })
			.refine((value) => value.trim() !== "", {
				error: "query is required",
			})
			.describe("Natural-language search query"),
		indexNames: indexNamesSchema,
		indexName: optionalString(
			"indexName",
			"Single fully-qualified index name to search",
		),
		schema: optionalString(
			"schema",
			"Restrict auto-discovered indexes to this catalog.schema",
		),
		numResults: optionalNumber(
			"numResults",
			"Maximum chunks to return (default 8, max 50)",
		),
	}),
);

type DatabricksQueryArgs = z.output<typeof queryIndexSchema>;

/**
 * Resolve which indexes `query_index` should search: explicit names win, then a
 * single explicit name, then every index in the (optionally schema-filtered)
 * workspace.
 */
async function resolveQueryIndexNames(
	credentials: Record<string, string>,
	args: DatabricksQueryArgs,
): Promise<string[]> {
	if (args.indexNames) {
		return args.indexNames;
	}
	if (args.indexName) {
		return [args.indexName];
	}

	const all = await listDatabricksVectorIndexes(credentials);
	const filtered = args.schema
		? all.filter((index) => index.schema === args.schema)
		: all;
	return filtered.map((index) => index.name);
}

const DATABRICKS_OPERATIONS: Record<string, OperationDefinition> = {
	query_index: defineOperation({
		description:
			"Hybrid semantic + keyword search over one or more vector indexes",
		keywords: [
			"search",
			"query",
			"find",
			"retrieve",
			"lookup",
			"rag",
			"knowledge",
		],
		schema: queryIndexSchema,
		access: "READ",
		chatEnabled: true,
		retrySafety: "SAFE",
		execute: async (args, context) => {
			// Guaranteed present: the WORKFLOW_INTEGRATION credential policy is
			// checked before execute() is reached.
			const credentials = context.credentials as Record<string, string>;

			const indexNames = await resolveQueryIndexNames(credentials, args);
			if (indexNames.length === 0) {
				throw new Error(
					"No Databricks vector indexes found for this query",
				);
			}

			const { chunks, failures, skippedIndexes } =
				await queryDatabricksVectorIndexes(credentials, {
					indexNames,
					query: args.query,
					numResults: args.numResults,
				});

			let text = chunks
				.map(
					(c) =>
						`[${c.indexName} #${c.id}] (${c.score.toFixed(3)}) ${c.content}`,
				)
				.join("\n\n");
			if (failures.length > 0) {
				text += `\n\n⚠ Partial results — failed indexes: ${failures.join("; ")}`;
			}
			if (skippedIndexes.length > 0) {
				text += `\n\n⚠ ${skippedIndexes.length} selected index(es) beyond the ${MAX_QUERY_INDEXES}-index limit were not searched: ${skippedIndexes.join(", ")}`;
			}

			return { data: { chunks, failures, skippedIndexes }, text };
		},
	}),
	list_indexes: defineOperation({
		description: "List available vector search indexes by schema",
		keywords: ["list", "indexes", "catalog", "schema"],
		schema: z.strictObject({
			schema: optionalString(
				"schema",
				"Only return indexes in this catalog.schema (e.g. main.rag)",
			),
		}),
		access: "READ",
		chatEnabled: true,
		retrySafety: "SAFE",
		execute: async (args, context) => {
			const credentials = context.credentials as Record<string, string>;
			const all = await listDatabricksVectorIndexes(credentials);
			const indexes = args.schema
				? all.filter((index) => index.schema === args.schema)
				: all;
			return {
				data: indexes,
				text: indexes.map((index) => index.name).join("\n"),
			};
		},
	}),
};

// ─── Registry ────────────────────────────────────────────────────────────────

export const integrationExecutorRegistry = {
	NHTSA_VPIC: {
		description:
			"Look up US vehicle data — decode VINs, search manufacturers, makes, and models using the NHTSA VPIC database",
		capabilities: [
			"vin_decoding",
			"vehicle_lookup",
			"manufacturer_search",
			"make_model_search",
			"vehicle_data",
			"automotive_data",
		],
		providerKeywords: [
			"vin",
			"decode vin",
			"vehicle identification number",
			"car make",
			"car model",
			"vehicle manufacturer",
			"nhtsa",
			"vehicle lookup",
			"what car is this",
			"vehicle type",
			"auto manufacturer",
			"vehicle data",
		],
		credentialPolicy: { kind: "ACTIVE_CONFIGURATION", secrets: "NONE" },
		operations: NHTSA_OPERATIONS,
	},
	DATABRICKS_VECTOR_SEARCH: {
		description:
			"Semantic and hybrid search over vector indexes in your Databricks workspace (RAG knowledge retrieval)",
		capabilities: [
			"vector_search",
			"semantic_search",
			"knowledge_retrieval",
			"rag",
		],
		providerKeywords: [
			"databricks",
			"vector",
			"embedding",
			"rag",
			"semantic search",
			"knowledge base",
			"unity catalog",
		],
		credentialPolicy: {
			kind: "WORKFLOW_INTEGRATION",
			requiredKeys: DATABRICKS_CREDENTIAL_KEYS,
		},
		operations: DATABRICKS_OPERATIONS,
	},
} satisfies Partial<
	Record<WorkflowIntegrationProvider, IntegrationExecutorDefinition>
>;

export type RegisteredIntegrationProvider =
	keyof typeof integrationExecutorRegistry;

// ─── Lookups ─────────────────────────────────────────────────────────────────

export function isRegisteredIntegrationProvider(
	provider: string,
): provider is RegisteredIntegrationProvider {
	return Object.hasOwn(integrationExecutorRegistry, provider);
}

export function getIntegrationExecutor(
	provider: string,
): IntegrationExecutorDefinition | undefined {
	return isRegisteredIntegrationProvider(provider)
		? integrationExecutorRegistry[provider]
		: undefined;
}

export function getIntegrationOperation(
	provider: string,
	operation: string,
): OperationDefinition | undefined {
	const executor = getIntegrationExecutor(provider);
	if (!executor || !Object.hasOwn(executor.operations, operation)) {
		return undefined;
	}
	return executor.operations[operation];
}

/**
 * Canonical READ/WRITE effect for a registered operation, or `undefined` when
 * the provider/operation is not registered (callers fall back to their own
 * heuristic).
 */
export function getRegisteredOperationAccess(
	provider: string,
	operation: string,
): "READ" | "WRITE" | undefined {
	return getIntegrationOperation(provider, operation)?.access;
}

export function listRegisteredIntegrationProviders(): RegisteredIntegrationProvider[] {
	return Object.keys(
		integrationExecutorRegistry,
	) as RegisteredIntegrationProvider[];
}

export function listIntegrationOperationNames(provider: string): string[] {
	const executor = getIntegrationExecutor(provider);
	return executor ? Object.keys(executor.operations) : [];
}

/** Natural-language keyword map (operation → cues) for step-description matching. */
export function getIntegrationOperationKeywords(
	provider: string,
): Record<string, string[]> | undefined {
	const executor = getIntegrationExecutor(provider);
	if (!executor) {
		return undefined;
	}
	return Object.fromEntries(
		Object.entries(executor.operations).map(([name, definition]) => [
			name,
			[...definition.keywords],
		]),
	);
}

// ─── Chat surface ────────────────────────────────────────────────────────────

/** An operation as advertised to the LOOM chat surface. */
export interface ChatEnabledOperation {
	name: string;
	description: string;
	/** Registry-derived JSON Schema for this operation's arguments. */
	inputSchema: Record<string, unknown>;
}

/**
 * Chat-enabled operations per provider, derived once at module load. LOOM
 * discovery asks for these twice per candidate integration (embedding text and
 * result metadata), so re-deriving them per call is 2xN wasted passes over the
 * registry for a value that cannot change at runtime.
 */
const CHAT_ENABLED_OPERATIONS: Record<
	string,
	ReadonlyArray<ChatEnabledOperation>
> = Object.fromEntries(
	listRegisteredIntegrationProviders().map((provider) => [
		provider,
		Object.entries(integrationExecutorRegistry[provider].operations)
			.filter(([, definition]) => definition.chatEnabled)
			.map(([name, definition]) => ({
				name,
				description: definition.description,
				// Carried so chat discovery can advertise the real argument
				// contract instead of an unconstrained object.
				inputSchema: definition.inputSchema,
			})),
	]),
);

const CHAT_ENABLED_PROVIDERS: RegisteredIntegrationProvider[] =
	listRegisteredIntegrationProviders().filter(
		(provider) => CHAT_ENABLED_OPERATIONS[provider].length > 0,
	);

/** Providers exposing at least one chat-enabled operation. */
export function listChatEnabledIntegrationProviders(): RegisteredIntegrationProvider[] {
	return CHAT_ENABLED_PROVIDERS;
}

export function listChatEnabledOperations(
	provider: string,
): ReadonlyArray<ChatEnabledOperation> {
	return CHAT_ENABLED_OPERATIONS[provider] ?? [];
}

// ─── Execution ───────────────────────────────────────────────────────────────

/**
 * Thrown when a provider/operation pair is not in the registry, so callers can
 * distinguish "not routable here" from "the remote call failed".
 */
export class UnknownIntegrationOperationError extends Error {
	constructor(
		readonly provider: string,
		readonly operation?: string,
	) {
		super(
			operation
				? `Unsupported operation "${operation}" for integration provider ${provider}. Supported: ${listIntegrationOperationNames(provider).join(", ")}`
				: `Unsupported integration provider: ${provider}`,
		);
		this.name = "UnknownIntegrationOperationError";
	}
}

/** Thrown when the tenant's stored credentials are missing a required key. */
export class MissingIntegrationCredentialsError extends Error {
	constructor(
		readonly provider: string,
		readonly missingKeys: string[],
	) {
		super(
			`${provider} integration is missing required credentials (${missingKeys.join(", ")}). Please reconnect it in Settings > Integrations.`,
		);
		this.name = "MissingIntegrationCredentialsError";
	}
}

/**
 * Credential keys the provider's policy demands but the caller did not supply.
 * Empty array = satisfied.
 */
export function findMissingCredentialKeys(
	provider: string,
	credentials: Record<string, string> | null | undefined,
): string[] {
	const executor = getIntegrationExecutor(provider);
	if (
		!executor ||
		executor.credentialPolicy.kind !== "WORKFLOW_INTEGRATION"
	) {
		return [];
	}
	return executor.credentialPolicy.requiredKeys.filter(
		(key) => !credentials?.[key],
	);
}

/**
 * Flatten a Zod failure into one actionable sentence. Field schemas carry
 * messages that already name their field; anything that falls back to Zod's
 * default wording gets its path prefixed so the model still knows what to fix.
 */
function flattenZodIssues(error: z.ZodError): string {
	return error.issues
		.map((issue) => {
			const path = issue.path.join(".");
			return path && !issue.message.includes(`"${path}"`)
				? `${path}: ${issue.message}`
				: issue.message;
		})
		.join("; ");
}

/**
 * Resolve a provider/operation pair to its definition, or throw the canonical
 * "unsupported" error. Callers on both execution paths use this so the error
 * wording exists in exactly one place.
 */
export function resolveIntegrationOperation(
	provider: string,
	operation: string,
): OperationDefinition {
	if (!getIntegrationExecutor(provider)) {
		throw new UnknownIntegrationOperationError(provider);
	}
	const definition = getIntegrationOperation(provider, operation);
	if (!definition) {
		throw new UnknownIntegrationOperationError(provider, operation);
	}
	return definition;
}

/**
 * Validate arguments against an operation's declared schema, tagging the
 * failure with the provider/operation so the model can see what it got wrong.
 */
function parseIntegrationOperationArgs(
	provider: string,
	operation: string,
	definition: OperationDefinition,
	args: Record<string, unknown>,
): unknown {
	try {
		return definition.parseArgs(args);
	} catch (error) {
		if (error instanceof z.ZodError) {
			throw new IntegrationArgumentError(
				`Invalid arguments for ${provider}.${operation}: ${flattenZodIssues(error)}`,
			);
		}
		throw error;
	}
}

/**
 * Validate and run a registered integration operation.
 *
 * Rejects unknown providers, unknown operations, malformed arguments, and
 * incomplete credentials BEFORE any network call, so neither a typo nor a
 * wrong-typed field can reach a provider API.
 */
export async function executeRegisteredIntegrationOperation(params: {
	provider: string;
	operation: string;
	args: Record<string, unknown>;
	credentials?: Record<string, string> | null;
	idempotencyKey?: string;
	signal?: AbortSignal;
}): Promise<IntegrationExecutionResult> {
	const { provider, operation, args } = params;

	const definition = resolveIntegrationOperation(provider, operation);

	// Enforce the retry-safety contract the definition declares. No registered
	// operation is non-SAFE today, so this is a dead path guarding the first
	// write-capable provider: retrying a dispatched write without an
	// idempotency key can duplicate it.
	if (definition.retrySafety !== "SAFE" && !params.idempotencyKey) {
		throw new Error(
			`${provider}.${operation} declares retrySafety "${definition.retrySafety}" and cannot run without an idempotency key.`,
		);
	}

	const parsedArgs = parseIntegrationOperationArgs(
		provider,
		operation,
		definition,
		args,
	);

	const missingKeys = findMissingCredentialKeys(provider, params.credentials);
	if (missingKeys.length > 0) {
		throw new MissingIntegrationCredentialsError(provider, missingKeys);
	}

	return definition.execute(parsedArgs, {
		credentials: params.credentials ?? undefined,
		idempotencyKey: params.idempotencyKey,
		signal: params.signal,
	});
}
