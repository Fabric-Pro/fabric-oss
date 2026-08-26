/**
 * Contract tests for the shared integration executor registry.
 *
 * The registry is the single source of truth for which providers/operations are
 * directly executable, what they cost (READ vs WRITE), and what credentials
 * they need. These tests guard the invariants every consumer relies on.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
	executeNhtsaTool: vi.fn(),
	listDatabricksVectorIndexes: vi.fn(),
	queryDatabricksVectorIndexes: vi.fn(),
}));

vi.mock("../src/nhtsa", () => ({ executeNhtsaTool: h.executeNhtsaTool }));
vi.mock("../src/databricks-vector-search", () => ({
	listDatabricksVectorIndexes: h.listDatabricksVectorIndexes,
	queryDatabricksVectorIndexes: h.queryDatabricksVectorIndexes,
	MAX_QUERY_INDEXES: 5,
}));

const {
	executeRegisteredIntegrationOperation,
	findMissingCredentialKeys,
	IntegrationArgumentError,
	getIntegrationOperationKeywords,
	getRegisteredOperationAccess,
	integrationExecutorRegistry,
	isRegisteredIntegrationProvider,
	listChatEnabledIntegrationProviders,
	listChatEnabledOperations,
	listIntegrationOperationNames,
	listRegisteredIntegrationProviders,
	MissingIntegrationCredentialsError,
	toAdvertisedJsonSchema,
	UnknownIntegrationOperationError,
} = await import("../src/executor-registry");

/** Minimum arguments each operation accepts, for round-trip schema checks. */
const VALID_ARGS: Record<string, Record<string, unknown>> = {
	"NHTSA_VPIC.decode_vin": { vin: "1FT" },
	"NHTSA_VPIC.decode_vin_batch": { vins: ["1FT"] },
	"NHTSA_VPIC.decode_wmi": { wmi: "1FT" },
	"NHTSA_VPIC.get_all_manufacturers": {},
	"NHTSA_VPIC.get_manufacturer_details": { manufacturer: "Ford" },
	"NHTSA_VPIC.get_all_makes": {},
	"NHTSA_VPIC.get_models_for_make": { make: "Ford" },
	"NHTSA_VPIC.get_models_for_make_year": { make: "Ford", year: 2020 },
	"NHTSA_VPIC.get_vehicle_types_for_make": { make: "Ford" },
	"DATABRICKS_VECTOR_SEARCH.query_index": { query: "x" },
	"DATABRICKS_VECTOR_SEARCH.list_indexes": {},
};

function eachOperation(): Array<{
	label: string;
	definition: (typeof integrationExecutorRegistry)["NHTSA_VPIC"]["operations"][string];
}> {
	const entries = [];
	for (const provider of listRegisteredIntegrationProviders()) {
		for (const [name, definition] of Object.entries(
			integrationExecutorRegistry[provider].operations,
		)) {
			entries.push({ label: `${provider}.${name}`, definition });
		}
	}
	return entries;
}

const DATABRICKS_CREDS = {
	DATABRICKS_HOST: "https://example.azuredatabricks.net",
	DATABRICKS_CLIENT_ID: "client",
	DATABRICKS_CLIENT_SECRET: "secret",
};

beforeEach(() => {
	h.executeNhtsaTool.mockReset();
	h.listDatabricksVectorIndexes.mockReset();
	h.queryDatabricksVectorIndexes.mockReset();
});

describe("registry shape", () => {
	// Test 1
	it("registers only providers that exist in the Prisma WorkflowIntegrationProvider enum", () => {
		const schema = readFileSync(
			join(__dirname, "../../database/prisma/schema.prisma"),
			"utf8",
		);
		const block = schema.match(
			/enum WorkflowIntegrationProvider \{([^}]*)\}/,
		);
		expect(
			block,
			"WorkflowIntegrationProvider enum not found",
		).not.toBeNull();

		const enumValues = new Set(
			(block?.[1] ?? "")
				.split("\n")
				.map((line) => line.trim())
				.filter((line) => line.length > 0 && !line.startsWith("//")),
		);

		for (const provider of listRegisteredIntegrationProviders()) {
			expect(
				enumValues.has(provider),
				`${provider} is not a WorkflowIntegrationProvider`,
			).toBe(true);
		}
	});

	// Test 2
	it("gives every operation a description, input schema, access, retry policy and executor", () => {
		for (const provider of listRegisteredIntegrationProviders()) {
			const executor = integrationExecutorRegistry[provider];
			expect(executor.description.length).toBeGreaterThan(0);
			expect(executor.capabilities.length).toBeGreaterThan(0);
			expect(Object.keys(executor.operations).length).toBeGreaterThan(0);

			for (const [name, operation] of Object.entries(
				executor.operations,
			)) {
				const label = `${provider}.${name}`;
				expect(operation.description.length, label).toBeGreaterThan(0);
				expect(operation.inputSchema.type, label).toBe("object");
				expect(["READ", "WRITE"], label).toContain(operation.access);
				expect(
					[
						"SAFE",
						"REQUIRES_IDEMPOTENCY_KEY",
						"DO_NOT_RETRY_AFTER_DISPATCH",
					],
					label,
				).toContain(operation.retrySafety);
				expect(typeof operation.execute, label).toBe("function");
			}
		}
	});

	it("ships only READ operations as chat-enabled", () => {
		for (const provider of listRegisteredIntegrationProviders()) {
			for (const operation of Object.values(
				integrationExecutorRegistry[provider].operations,
			)) {
				if (operation.chatEnabled) {
					expect(operation.access).toBe("READ");
					expect(operation.retrySafety).toBe("SAFE");
				}
			}
		}
	});

	it("declares NHTSA credentialless but still configuration-bound", () => {
		expect(integrationExecutorRegistry.NHTSA_VPIC.credentialPolicy).toEqual(
			{ kind: "ACTIVE_CONFIGURATION", secrets: "NONE" },
		);
		expect(findMissingCredentialKeys("NHTSA_VPIC", {})).toEqual([]);
	});

	it("exposes lookup helpers consistently", () => {
		expect(isRegisteredIntegrationProvider("NHTSA_VPIC")).toBe(true);
		expect(isRegisteredIntegrationProvider("SLACK")).toBe(false);
		expect(listChatEnabledIntegrationProviders().sort()).toEqual([
			"DATABRICKS_VECTOR_SEARCH",
			"NHTSA_VPIC",
		]);
		expect(
			listIntegrationOperationNames("DATABRICKS_VECTOR_SEARCH"),
		).toEqual(["query_index", "list_indexes"]);
		expect(
			listChatEnabledOperations("DATABRICKS_VECTOR_SEARCH").map(
				(op) => op.name,
			),
		).toEqual(["query_index", "list_indexes"]);
		expect(
			getIntegrationOperationKeywords("NHTSA_VPIC")?.decode_vin,
		).toContain("decode vin");
		expect(getIntegrationOperationKeywords("SLACK")).toBeUndefined();
	});

	// Test 13 (registry half — the authority-gate half lives in @repo/temporal)
	it("classifies every NHTSA and Databricks operation as READ", () => {
		expect(getRegisteredOperationAccess("NHTSA_VPIC", "decode_vin")).toBe(
			"READ",
		);
		expect(
			getRegisteredOperationAccess(
				"DATABRICKS_VECTOR_SEARCH",
				"query_index",
			),
		).toBe("READ");
		expect(
			getRegisteredOperationAccess(
				"DATABRICKS_VECTOR_SEARCH",
				"list_indexes",
			),
		).toBe("READ");
		expect(
			getRegisteredOperationAccess("SLACK", "send_message"),
		).toBeUndefined();
	});
});

// The point of the Zod refactor: the advertised JSON Schema and the runtime
// validator are ONE declaration, so they cannot drift. A hand-edited
// `inputSchema` would fail the identity check; a schema whose advertised
// required-set disagrees with what the validator actually enforces would fail
// the round-trip checks.
describe("inputSchema is derived from the zod schema", () => {
	it("equals the schema's own rendering for every operation", () => {
		for (const { label, definition } of eachOperation()) {
			expect(definition.inputSchema, label).toEqual(
				toAdvertisedJsonSchema(definition.schema),
			);
		}
	});

	it("advertises no JSON Schema dialect key", () => {
		for (const { label, definition } of eachOperation()) {
			expect(definition.inputSchema, label).not.toHaveProperty("$schema");
			expect(definition.inputSchema.type, label).toBe("object");
		}
	});

	// Strict schemas advertise the closed contract they enforce, so the model
	// is told up front that an unknown key is an error rather than ignored.
	it("advertises every operation as closed to unknown keys", () => {
		for (const { label, definition } of eachOperation()) {
			expect(definition.inputSchema.additionalProperties, label).toBe(
				false,
			);
		}
	});

	it("rejects omission of every field it advertises as required", () => {
		for (const { label, definition } of eachOperation()) {
			const required = (definition.inputSchema.required ??
				[]) as string[];
			const valid = VALID_ARGS[label];
			expect(valid, `no VALID_ARGS fixture for ${label}`).toBeDefined();

			for (const field of required) {
				const withoutField = { ...valid };
				delete withoutField[field];
				expect(
					() => definition.parseArgs(withoutField),
					`${label} advertises "${field}" as required but accepted its omission`,
				).toThrow();
			}
		}
	});

	it("accepts omission of every field it advertises as optional", () => {
		for (const { label, definition } of eachOperation()) {
			const properties = Object.keys(
				(definition.inputSchema.properties ?? {}) as Record<
					string,
					unknown
				>,
			);
			const required = (definition.inputSchema.required ??
				[]) as string[];
			const optional = properties.filter((p) => !required.includes(p));

			// The fixture supplies only required fields, so parsing it exercises
			// omission of every optional one at once.
			expect(
				() => definition.parseArgs(VALID_ARGS[label]),
				`${label} advertises ${optional.join(", ")} as optional but rejected the minimal payload`,
			).not.toThrow();
		}
	});
});

describe("executeRegisteredIntegrationOperation validation", () => {
	// Test 17
	it("rejects an unknown provider before any network call", async () => {
		await expect(
			executeRegisteredIntegrationOperation({
				provider: "SLACK",
				operation: "send_message",
				args: {},
			}),
		).rejects.toBeInstanceOf(UnknownIntegrationOperationError);
		expect(h.executeNhtsaTool).not.toHaveBeenCalled();
	});

	// Test 17
	it("rejects an unknown Databricks operation before any network call", async () => {
		await expect(
			executeRegisteredIntegrationOperation({
				provider: "DATABRICKS_VECTOR_SEARCH",
				operation: "query_indx",
				args: { query: "hello" },
				credentials: DATABRICKS_CREDS,
			}),
		).rejects.toThrow(/Unsupported operation "query_indx"/);
		expect(h.queryDatabricksVectorIndexes).not.toHaveBeenCalled();
		expect(h.listDatabricksVectorIndexes).not.toHaveBeenCalled();
	});

	// Test 17
	it("rejects a query_index call with no query before any network call", async () => {
		await expect(
			executeRegisteredIntegrationOperation({
				provider: "DATABRICKS_VECTOR_SEARCH",
				operation: "query_index",
				args: { indexName: "main.rag.docs" },
				credentials: DATABRICKS_CREDS,
			}),
		).rejects.toThrow("query is required");
		expect(h.queryDatabricksVectorIndexes).not.toHaveBeenCalled();
		expect(h.listDatabricksVectorIndexes).not.toHaveBeenCalled();
	});

	// Guards the first write-capable provider: no registered operation is
	// non-SAFE today, so this path is unreachable in production and this
	// synthetic entry is the only way to prove the contract is enforced.
	it("refuses a non-SAFE operation with no idempotency key", async () => {
		const registry = integrationExecutorRegistry as unknown as Record<
			string,
			{ operations: Record<string, unknown> }
		>;
		const operations = registry.NHTSA_VPIC.operations;
		const borrowed = operations.decode_vin as Record<string, unknown>;
		operations.__synthetic_write__ = {
			...borrowed,
			retrySafety: "REQUIRES_IDEMPOTENCY_KEY",
			access: "WRITE",
			chatEnabled: false,
		};

		try {
			await expect(
				executeRegisteredIntegrationOperation({
					provider: "NHTSA_VPIC",
					operation: "__synthetic_write__",
					args: { vin: "1FT" },
				}),
			).rejects.toThrow(/cannot run without an idempotency key/);
			expect(h.executeNhtsaTool).not.toHaveBeenCalled();

			// Supplying the key clears the guard.
			h.executeNhtsaTool.mockResolvedValue({});
			await executeRegisteredIntegrationOperation({
				provider: "NHTSA_VPIC",
				operation: "__synthetic_write__",
				args: { vin: "1FT" },
				idempotencyKey: "key-1",
			});
			expect(h.executeNhtsaTool).toHaveBeenCalled();
		} finally {
			delete operations.__synthetic_write__;
		}
	});

	it("rejects incomplete credentials before any network call", async () => {
		await expect(
			executeRegisteredIntegrationOperation({
				provider: "DATABRICKS_VECTOR_SEARCH",
				operation: "list_indexes",
				args: {},
				credentials: {
					DATABRICKS_HOST: DATABRICKS_CREDS.DATABRICKS_HOST,
				},
			}),
		).rejects.toBeInstanceOf(MissingIntegrationCredentialsError);
		expect(h.listDatabricksVectorIndexes).not.toHaveBeenCalled();

		expect(
			findMissingCredentialKeys("DATABRICKS_VECTOR_SEARCH", {
				DATABRICKS_HOST: DATABRICKS_CREDS.DATABRICKS_HOST,
			}),
		).toEqual(["DATABRICKS_CLIENT_ID", "DATABRICKS_CLIENT_SECRET"]);
	});
});

describe("NHTSA execution", () => {
	it("dispatches the operation name and returns data plus text", async () => {
		h.executeNhtsaTool.mockResolvedValue({ vin: "1FT", count: 1 });

		const result = await executeRegisteredIntegrationOperation({
			provider: "NHTSA_VPIC",
			operation: "decode_vin",
			args: { vin: "1FT" },
			credentials: { NHTSA_ENABLED: "true" },
		});

		expect(h.executeNhtsaTool).toHaveBeenCalledWith(
			"decode_vin",
			{ vin: "1FT" },
			{ signal: undefined },
		);
		expect(result.data).toEqual({ vin: "1FT", count: 1 });
		expect(JSON.parse(result.text)).toEqual({ vin: "1FT", count: 1 });
	});

	it("routes each registered operation to its own VPIC method", async () => {
		h.executeNhtsaTool.mockResolvedValue({});
		for (const operation of listIntegrationOperationNames("NHTSA_VPIC")) {
			h.executeNhtsaTool.mockClear();
			await executeRegisteredIntegrationOperation({
				provider: "NHTSA_VPIC",
				operation,
				args: VALID_ARGS[`NHTSA_VPIC.${operation}`],
			});
			expect(h.executeNhtsaTool).toHaveBeenCalledWith(
				operation,
				expect.any(Object),
				{ signal: undefined },
			);
		}
	});

	// Defect 5: a timed-out chat tool call must cancel the provider request.
	it("forwards the caller's abort signal to the VPIC executor", async () => {
		h.executeNhtsaTool.mockResolvedValue({});
		const controller = new AbortController();

		await executeRegisteredIntegrationOperation({
			provider: "NHTSA_VPIC",
			operation: "decode_vin",
			args: { vin: "1FT" },
			signal: controller.signal,
		});

		expect(h.executeNhtsaTool).toHaveBeenCalledWith(
			"decode_vin",
			{ vin: "1FT" },
			{ signal: controller.signal },
		);
	});
});

// Defect 2 / test item 17: declared schemas are enforced, not decorative.
describe("operation argument validation", () => {
	it("rejects a wrong-typed required field before the network call", async () => {
		await expect(
			executeRegisteredIntegrationOperation({
				provider: "NHTSA_VPIC",
				operation: "decode_vin",
				args: { vin: 123 },
			}),
		).rejects.toBeInstanceOf(IntegrationArgumentError);
		expect(h.executeNhtsaTool).not.toHaveBeenCalled();
	});

	it("names the provider and operation in the failure", async () => {
		await expect(
			executeRegisteredIntegrationOperation({
				provider: "NHTSA_VPIC",
				operation: "decode_vin",
				args: {},
			}),
		).rejects.toThrow(
			'Invalid arguments for NHTSA_VPIC.decode_vin: "vin" is required',
		);
	});

	it("rejects a non-array indexNames instead of silently widening the search", async () => {
		await expect(
			executeRegisteredIntegrationOperation({
				provider: "DATABRICKS_VECTOR_SEARCH",
				operation: "query_index",
				args: { query: "x", indexNames: "main.rag.docs" },
				credentials: DATABRICKS_CREDS,
			}),
		).rejects.toThrow('"indexNames" must be an array');
		expect(h.listDatabricksVectorIndexes).not.toHaveBeenCalled();
		expect(h.queryDatabricksVectorIndexes).not.toHaveBeenCalled();
	});

	it("rejects an indexNames array with no usable entries", async () => {
		await expect(
			executeRegisteredIntegrationOperation({
				provider: "DATABRICKS_VECTOR_SEARCH",
				operation: "query_index",
				args: { query: "x", indexNames: [42, ""] },
				credentials: DATABRICKS_CREDS,
			}),
		).rejects.toThrow('"indexNames" contained no usable index names');
		expect(h.listDatabricksVectorIndexes).not.toHaveBeenCalled();
	});

	it("keeps sanitizing usable entries inside a well-formed array", async () => {
		h.queryDatabricksVectorIndexes.mockResolvedValue({
			chunks: [],
			failures: [],
			skippedIndexes: [],
		});

		await executeRegisteredIntegrationOperation({
			provider: "DATABRICKS_VECTOR_SEARCH",
			operation: "query_index",
			args: { query: "x", indexNames: ["a.b.c", 42, "", "d.e.f"] },
			credentials: DATABRICKS_CREDS,
		});

		expect(h.listDatabricksVectorIndexes).not.toHaveBeenCalled();
		expect(h.queryDatabricksVectorIndexes).toHaveBeenCalledWith(
			DATABRICKS_CREDS,
			expect.objectContaining({ indexNames: ["a.b.c", "d.e.f"] }),
		);
	});

	// A stripped unknown key is worse than a rejected one: `indexNamse` leaves
	// no selection, and resolveQueryIndexNames then searches every index in the
	// workspace — the opposite of what the caller asked for.
	it("rejects a misspelled narrowing field instead of widening the query", async () => {
		await expect(
			executeRegisteredIntegrationOperation({
				provider: "DATABRICKS_VECTOR_SEARCH",
				operation: "query_index",
				args: { query: "x", indexNamse: ["main.rag.docs"] },
				credentials: DATABRICKS_CREDS,
			}),
		).rejects.toThrow(
			/Invalid arguments for DATABRICKS_VECTOR_SEARCH\.query_index: .*indexNamse/,
		);
		expect(h.listDatabricksVectorIndexes).not.toHaveBeenCalled();
		expect(h.queryDatabricksVectorIndexes).not.toHaveBeenCalled();
	});

	it("rejects unknown keys on NHTSA operations too", async () => {
		await expect(
			executeRegisteredIntegrationOperation({
				provider: "NHTSA_VPIC",
				operation: "decode_vin",
				args: { vin: "1FT", modelYearr: "2020" },
			}),
		).rejects.toThrow(/modelYearr/);
		expect(h.executeNhtsaTool).not.toHaveBeenCalled();
	});

	// The alias is normalized away AND removed, so strict validation never
	// sees it as an unrecognized key.
	it("still accepts the question alias under strict validation", async () => {
		h.queryDatabricksVectorIndexes.mockResolvedValue({
			chunks: [],
			failures: [],
			skippedIndexes: [],
		});

		await executeRegisteredIntegrationOperation({
			provider: "DATABRICKS_VECTOR_SEARCH",
			operation: "query_index",
			args: { question: "onboarding", indexName: "a.b.c" },
			credentials: DATABRICKS_CREDS,
		});

		expect(h.queryDatabricksVectorIndexes).toHaveBeenCalledWith(
			DATABRICKS_CREDS,
			expect.objectContaining({ query: "onboarding" }),
		);
	});

	it("prefers an explicit query when both query and question are sent", async () => {
		h.queryDatabricksVectorIndexes.mockResolvedValue({
			chunks: [],
			failures: [],
			skippedIndexes: [],
		});

		await executeRegisteredIntegrationOperation({
			provider: "DATABRICKS_VECTOR_SEARCH",
			operation: "query_index",
			args: {
				query: "explicit",
				question: "alias",
				indexName: "a.b.c",
			},
			credentials: DATABRICKS_CREDS,
		});

		expect(h.queryDatabricksVectorIndexes).toHaveBeenCalledWith(
			DATABRICKS_CREDS,
			expect.objectContaining({ query: "explicit" }),
		);
	});

	it("rejects a wrong-typed list_indexes schema filter rather than listing everything", async () => {
		await expect(
			executeRegisteredIntegrationOperation({
				provider: "DATABRICKS_VECTOR_SEARCH",
				operation: "list_indexes",
				args: { schema: 7 },
				credentials: DATABRICKS_CREDS,
			}),
		).rejects.toThrow('"schema" must be a string');
		expect(h.listDatabricksVectorIndexes).not.toHaveBeenCalled();
	});

	it("rejects a non-numeric numResults", async () => {
		await expect(
			executeRegisteredIntegrationOperation({
				provider: "DATABRICKS_VECTOR_SEARCH",
				operation: "query_index",
				args: { query: "x", indexName: "a.b.c", numResults: "many" },
				credentials: DATABRICKS_CREDS,
			}),
		).rejects.toThrow('"numResults" must be a number');
		expect(h.queryDatabricksVectorIndexes).not.toHaveBeenCalled();
	});

	it("coerces quoted numbers, which models routinely emit", async () => {
		h.queryDatabricksVectorIndexes.mockResolvedValue({
			chunks: [],
			failures: [],
			skippedIndexes: [],
		});

		await executeRegisteredIntegrationOperation({
			provider: "DATABRICKS_VECTOR_SEARCH",
			operation: "query_index",
			args: { query: "x", indexName: "a.b.c", numResults: "10" },
			credentials: DATABRICKS_CREDS,
		});

		expect(h.queryDatabricksVectorIndexes).toHaveBeenCalledWith(
			DATABRICKS_CREDS,
			expect.objectContaining({ numResults: 10 }),
		);
	});

	it("accepts a semicolon-delimited VIN batch as well as an array", async () => {
		h.executeNhtsaTool.mockResolvedValue({});

		await executeRegisteredIntegrationOperation({
			provider: "NHTSA_VPIC",
			operation: "decode_vin_batch",
			args: { vins: "1FT; 2GH ;" },
		});

		expect(h.executeNhtsaTool).toHaveBeenCalledWith(
			"decode_vin_batch",
			{ vins: ["1FT", "2GH"] },
			{ signal: undefined },
		);
	});

	it("validates arguments before credentials are considered", async () => {
		// Both are wrong; the argument error is the actionable one.
		await expect(
			executeRegisteredIntegrationOperation({
				provider: "DATABRICKS_VECTOR_SEARCH",
				operation: "list_indexes",
				args: { schema: 7 },
				credentials: {},
			}),
		).rejects.toBeInstanceOf(IntegrationArgumentError);
	});
});

describe("Databricks execution", () => {
	it("queries the explicitly named indexes", async () => {
		h.queryDatabricksVectorIndexes.mockResolvedValue({
			chunks: [
				{
					indexName: "main.rag.docs",
					id: "1",
					content: "hi",
					score: 0.9,
				},
			],
			failures: [],
			skippedIndexes: [],
		});

		const result = await executeRegisteredIntegrationOperation({
			provider: "DATABRICKS_VECTOR_SEARCH",
			operation: "query_index",
			args: { query: "onboarding", indexNames: ["main.rag.docs"] },
			credentials: DATABRICKS_CREDS,
		});

		expect(h.listDatabricksVectorIndexes).not.toHaveBeenCalled();
		expect(h.queryDatabricksVectorIndexes).toHaveBeenCalledWith(
			DATABRICKS_CREDS,
			{
				indexNames: ["main.rag.docs"],
				query: "onboarding",
				numResults: undefined,
			},
		);
		expect(result.text).toContain("[main.rag.docs #1] (0.900) hi");
	});

	it("discovers indexes when none are named, honouring the schema filter", async () => {
		h.listDatabricksVectorIndexes.mockResolvedValue([
			{ name: "main.rag.docs", schema: "main.rag" },
			{ name: "main.other.docs", schema: "main.other" },
		]);
		h.queryDatabricksVectorIndexes.mockResolvedValue({
			chunks: [],
			failures: [],
			skippedIndexes: [],
		});

		await executeRegisteredIntegrationOperation({
			provider: "DATABRICKS_VECTOR_SEARCH",
			operation: "query_index",
			args: { query: "onboarding", schema: "main.rag" },
			credentials: DATABRICKS_CREDS,
		});

		expect(h.queryDatabricksVectorIndexes).toHaveBeenCalledWith(
			DATABRICKS_CREDS,
			expect.objectContaining({ indexNames: ["main.rag.docs"] }),
		);
	});

	it("fails when discovery turns up no index at all", async () => {
		h.listDatabricksVectorIndexes.mockResolvedValue([]);

		await expect(
			executeRegisteredIntegrationOperation({
				provider: "DATABRICKS_VECTOR_SEARCH",
				operation: "query_index",
				args: { query: "onboarding" },
				credentials: DATABRICKS_CREDS,
			}),
		).rejects.toThrow("No Databricks vector indexes found");
		expect(h.queryDatabricksVectorIndexes).not.toHaveBeenCalled();
	});

	it("implements the documented schema filter for list_indexes", async () => {
		h.listDatabricksVectorIndexes.mockResolvedValue([
			{ name: "main.rag.docs", schema: "main.rag" },
			{ name: "main.other.docs", schema: "main.other" },
		]);

		const filtered = await executeRegisteredIntegrationOperation({
			provider: "DATABRICKS_VECTOR_SEARCH",
			operation: "list_indexes",
			args: { schema: "main.rag" },
			credentials: DATABRICKS_CREDS,
		});
		expect(filtered.text).toBe("main.rag.docs");

		const all = await executeRegisteredIntegrationOperation({
			provider: "DATABRICKS_VECTOR_SEARCH",
			operation: "list_indexes",
			args: {},
			credentials: DATABRICKS_CREDS,
		});
		expect(all.text).toBe("main.rag.docs\nmain.other.docs");
	});

	it("surfaces partial failures and skipped indexes in the text rendering", async () => {
		h.queryDatabricksVectorIndexes.mockResolvedValue({
			chunks: [],
			failures: ["main.rag.b: boom"],
			skippedIndexes: ["main.rag.f"],
		});

		const result = await executeRegisteredIntegrationOperation({
			provider: "DATABRICKS_VECTOR_SEARCH",
			operation: "query_index",
			args: { question: "onboarding", indexNames: ["main.rag.a"] },
			credentials: DATABRICKS_CREDS,
		});

		expect(result.text).toContain("failed indexes: main.rag.b: boom");
		expect(result.text).toContain("beyond the 5-index limit");
	});
});
