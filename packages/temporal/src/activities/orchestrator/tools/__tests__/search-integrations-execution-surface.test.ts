/**
 * `executionSurface` filtering in integration discovery.
 *
 * The LOOM chat loop can only execute providers that have a shared executor, so
 * it opts in to a registry-derived filter. The planner/routing caller
 * (analyzeAndRoute) must keep seeing every configured integration — the step
 * path executes providers chat cannot.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { findManyMock, generateEmbeddingMock, generateEmbeddingsMock } =
	vi.hoisted(() => ({
		findManyMock: vi.fn(),
		generateEmbeddingMock: vi.fn(),
		generateEmbeddingsMock: vi.fn(),
	}));

vi.mock("@repo/database", () => ({
	db: { workflowIntegration: { findMany: findManyMock } },
}));

vi.mock("@repo/rag/lib/embedding/generator", () => ({
	generateEmbedding: generateEmbeddingMock,
	generateEmbeddings: generateEmbeddingsMock,
}));

vi.mock("../capability-embeddings", () => ({ cosineSimilarity: vi.fn() }));

const { searchAvailableIntegrations, INTEGRATION_PROVIDER_METADATA } =
	await import("../search-integrations");
const { integrationExecutorRegistry } = await import(
	"@repo/integrations/executor-registry"
);

function integration(
	id: string,
	provider: string,
	name = `${provider} integration`,
) {
	return { id, provider, name, isActive: true };
}

beforeEach(() => {
	findManyMock.mockReset();
	findManyMock.mockResolvedValue([]);
	// Force the deterministic keyword-only path — embeddings are network calls.
	generateEmbeddingMock.mockReset();
	generateEmbeddingMock.mockRejectedValue(new Error("no embeddings in test"));
	generateEmbeddingsMock.mockReset();
});

describe("executionSurface: LOOM_CHAT", () => {
	// Test 3 + 4: the registry filter is a database predicate, so it is applied
	// before scoring, sorting and `limit`.
	it("restricts the query to chat-executable providers before scoring or limit", async () => {
		findManyMock.mockResolvedValue([
			integration("i1", "NHTSA_VPIC"),
			integration("i2", "DATABRICKS_VECTOR_SEARCH"),
		]);

		await searchAvailableIntegrations({
			query: "decode vin",
			userId: "u1",
			organizationId: "org-1",
			limit: 1,
			executionSurface: "LOOM_CHAT",
		});

		const where = findManyMock.mock.calls[0]?.[0]?.where;
		expect(where.provider).toEqual({
			in: ["NHTSA_VPIC", "DATABRICKS_VECTOR_SEARCH"],
		});
		expect(where).not.toHaveProperty("take");
		expect(findManyMock.mock.calls[0]?.[0]).not.toHaveProperty("take");
	});

	// Test 3
	it("never returns a provider that has no shared executor", async () => {
		// A tenant with only SLACK configured: the predicate excludes it, so the
		// database returns nothing and chat is told it has no integrations.
		findManyMock.mockResolvedValue([]);

		const result = await searchAvailableIntegrations({
			query: "post to slack",
			userId: "u1",
			organizationId: "org-1",
			executionSurface: "LOOM_CHAT",
		});

		expect(result.results).toEqual([]);
		expect(result.totalIntegrationsSearched).toBe(0);
		expect(
			findManyMock.mock.calls[0]?.[0]?.where.provider.in,
		).not.toContain("SLACK");
	});

	// Test 4: `totalIntegrationsSearched` counts executable candidates only.
	it("counts only executable candidates as searched", async () => {
		findManyMock.mockResolvedValue([
			integration("i1", "NHTSA_VPIC"),
			integration("i2", "DATABRICKS_VECTOR_SEARCH"),
		]);

		const result = await searchAvailableIntegrations({
			query: "decode vin",
			userId: "u1",
			executionSurface: "LOOM_CHAT",
		});

		expect(result.totalIntegrationsSearched).toBe(2);
	});

	it("short-circuits when an explicit provider is not chat-executable", async () => {
		const result = await searchAvailableIntegrations({
			query: "post to slack",
			provider: "SLACK",
			userId: "u1",
			organizationId: "org-1",
			executionSurface: "LOOM_CHAT",
		});

		expect(result.results).toEqual([]);
		expect(findManyMock).not.toHaveBeenCalled();
	});

	it("intersects an explicit provider with the chat-executable set", async () => {
		findManyMock.mockResolvedValue([integration("i1", "NHTSA_VPIC")]);

		await searchAvailableIntegrations({
			query: "decode vin",
			provider: "NHTSA_VPIC",
			userId: "u1",
			executionSurface: "LOOM_CHAT",
		});

		expect(findManyMock.mock.calls[0]?.[0]?.where.provider).toEqual({
			in: ["NHTSA_VPIC"],
		});
	});

	// Test 7
	it("keeps the org tenant predicate member-wide and the personal one owner-scoped", async () => {
		await searchAvailableIntegrations({
			query: "decode vin",
			userId: "member-b",
			organizationId: "org-1",
			executionSurface: "LOOM_CHAT",
		});
		expect(findManyMock.mock.calls[0]?.[0]?.where).toEqual({
			organizationId: "org-1",
			isActive: true,
			provider: { in: ["NHTSA_VPIC", "DATABRICKS_VECTOR_SEARCH"] },
		});

		findManyMock.mockClear();
		await searchAvailableIntegrations({
			query: "decode vin",
			userId: "member-b",
			executionSurface: "LOOM_CHAT",
		});
		expect(findManyMock.mock.calls[0]?.[0]?.where).toEqual({
			userId: "member-b",
			organizationId: null,
			isActive: true,
			provider: { in: ["NHTSA_VPIC", "DATABRICKS_VECTOR_SEARCH"] },
		});
	});

	// Test 6
	it("returns exactly the registry's operation metadata", async () => {
		findManyMock.mockResolvedValue([
			integration("i2", "DATABRICKS_VECTOR_SEARCH"),
		]);

		const result = await searchAvailableIntegrations({
			query: "databricks semantic search",
			userId: "u1",
			minConfidence: 0,
			executionSurface: "LOOM_CHAT",
		});

		const registryEntry =
			integrationExecutorRegistry.DATABRICKS_VECTOR_SEARCH;
		expect(result.results[0].description).toBe(registryEntry.description);
		expect(result.results[0].capabilities).toEqual([
			...registryEntry.capabilities,
		]);
		expect(result.results[0].operations).toEqual(
			Object.entries(registryEntry.operations).map(([name, op]) => ({
				name,
				description: op.description,
				inputSchema: op.inputSchema,
			})),
		);
	});

	// The model needs each operation's real argument contract, not just its
	// name — otherwise it guesses at required fields and burns retries.
	it("carries each operation's registry-derived input schema", async () => {
		findManyMock.mockResolvedValue([
			integration("i2", "DATABRICKS_VECTOR_SEARCH"),
		]);

		const result = await searchAvailableIntegrations({
			query: "databricks semantic search",
			userId: "u1",
			minConfidence: 0,
			executionSurface: "LOOM_CHAT",
		});

		const queryIndex = result.results[0].operations.find(
			(op) => op.name === "query_index",
		);
		expect(queryIndex?.inputSchema).toBe(
			integrationExecutorRegistry.DATABRICKS_VECTOR_SEARCH.operations
				.query_index.inputSchema,
		);
		const properties = (
			queryIndex?.inputSchema as { properties: Record<string, unknown> }
		).properties;
		expect(Object.keys(properties)).toContain("indexNames");
		expect(
			(queryIndex?.inputSchema as { required: string[] }).required,
		).toEqual(["query"]);
	});
});

describe("default (planner) surface", () => {
	// Test 5
	it("leaves the query untouched so analyzeAndRoute still sees every provider", async () => {
		findManyMock.mockResolvedValue([integration("i3", "SLACK")]);

		const result = await searchAvailableIntegrations({
			query: "post to slack",
			userId: "u1",
			organizationId: "org-1",
			minConfidence: 0,
		});

		expect(findManyMock.mock.calls[0]?.[0]?.where).toEqual({
			organizationId: "org-1",
			isActive: true,
		});
		expect(result.results.map((r) => r.provider)).toEqual(["SLACK"]);
	});

	// The schemas are a chat-surface addition; leaking them here would change
	// the planner's activity output for no reason.
	it("omits operation input schemas for a registered provider", async () => {
		findManyMock.mockResolvedValue([
			integration("i2", "DATABRICKS_VECTOR_SEARCH"),
		]);

		const result = await searchAvailableIntegrations({
			query: "databricks semantic search",
			userId: "u1",
			minConfidence: 0,
		});

		for (const operation of result.results[0].operations) {
			expect(operation).not.toHaveProperty("inputSchema");
		}
	});

	it("keeps a plain provider filter when no surface is given", async () => {
		findManyMock.mockResolvedValue([]);

		await searchAvailableIntegrations({
			query: "post to slack",
			provider: "SLACK",
			userId: "u1",
		});

		expect(findManyMock.mock.calls[0]?.[0]?.where.provider).toBe("SLACK");
	});

	// Test item 5, differential form: for the planner path, passing
	// `executionSurface: undefined` must produce the same query AND the same
	// full result objects as not passing the field at all. This is what
	// guarantees analyzeAndRoute is untouched by the chat-surface work.
	it("is output-identical whether the field is omitted or explicitly undefined", async () => {
		const fixtures = [
			integration("i1", "SLACK"),
			integration("i2", "NHTSA_VPIC"),
			integration("i3", "MICROSOFT_GRAPH"),
		];
		const baseInput = {
			query: "notify the team about the vehicle report",
			userId: "u1",
			organizationId: "org-1",
			limit: 10,
			minConfidence: 0,
		};

		findManyMock.mockResolvedValue(fixtures);
		const omitted = await searchAvailableIntegrations({ ...baseInput });
		const omittedWhere = findManyMock.mock.calls[0]?.[0];

		findManyMock.mockClear();
		findManyMock.mockResolvedValue(fixtures);
		const explicitUndefined = await searchAvailableIntegrations({
			...baseInput,
			executionSurface: undefined,
		});
		const explicitWhere = findManyMock.mock.calls[0]?.[0];

		expect(explicitWhere).toEqual(omittedWhere);
		// durationMs is wall-clock; everything else must match exactly.
		expect(explicitUndefined.results).toEqual(omitted.results);
		expect(explicitUndefined.totalIntegrationsSearched).toBe(
			omitted.totalIntegrationsSearched,
		);

		// And the planner still sees providers chat cannot execute. (Which of
		// them clear the relevance threshold is up to the scorer; the point is
		// that the executor registry never removed them.)
		expect(omitted.results.map((r) => r.provider)).toContain(
			"MICROSOFT_GRAPH",
		);
		expect(omittedWhere.where).toEqual({
			organizationId: "org-1",
			isActive: true,
		});
	});

	it("returns full legacy metadata for a non-registered provider", async () => {
		findManyMock.mockResolvedValue([integration("i3", "MICROSOFT_GRAPH")]);

		const result = await searchAvailableIntegrations({
			query: "teams messages",
			userId: "u1",
			minConfidence: 0,
		});

		const entry = result.results[0];
		expect(entry.provider).toBe("MICROSOFT_GRAPH");
		expect(entry.description).toBe(
			INTEGRATION_PROVIDER_METADATA.MICROSOFT_GRAPH.description,
		);
		expect(entry.operations).toEqual(
			INTEGRATION_PROVIDER_METADATA.MICROSOFT_GRAPH.operations,
		);
		expect(entry.capabilities).toEqual(
			INTEGRATION_PROVIDER_METADATA.MICROSOFT_GRAPH.capabilities,
		);
	});
});

describe("provider metadata", () => {
	// Test 6: discovery metadata for registered providers has exactly one home.
	// Asserted against the registry's own values directly rather than by
	// rebuilding the mapping here — a mirrored implementation would pass even
	// if both sides drifted the same way.
	it("surfaces the registry's values for a registered provider", () => {
		const registryEntry = integrationExecutorRegistry.NHTSA_VPIC;
		const metadata = INTEGRATION_PROVIDER_METADATA.NHTSA_VPIC;

		expect(metadata.description).toBe(registryEntry.description);
		expect(metadata.capabilities).toEqual([...registryEntry.capabilities]);
		expect(metadata.keywords).toEqual([...registryEntry.providerKeywords]);
		expect(metadata.operations.map((op) => op.name)).toEqual(
			Object.keys(registryEntry.operations),
		);
		expect(
			metadata.operations.find((op) => op.name === "decode_vin")
				?.description,
		).toBe(registryEntry.operations.decode_vin.description);
	});

	it("keeps legacy providers that have no shared executor", () => {
		expect(INTEGRATION_PROVIDER_METADATA.SLACK).toBeDefined();
		expect(INTEGRATION_PROVIDER_METADATA.MICROSOFT_GRAPH).toBeDefined();
		expect(
			INTEGRATION_PROVIDER_METADATA.SLACK.operations.length,
		).toBeGreaterThan(0);
	});
});
