import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
	findFirstMock,
	fetchCredentialsByIdInTenantMock,
	queryDatabricksVectorIndexesMock,
	contextCurrentMock,
} = vi.hoisted(() => ({
	findFirstMock: vi.fn(),
	fetchCredentialsByIdInTenantMock: vi.fn(),
	queryDatabricksVectorIndexesMock: vi.fn(),
	contextCurrentMock: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	db: {
		agentTemplateInstance: {
			findFirst: findFirstMock,
		},
	},
	fetchCredentialsByIdInTenant: fetchCredentialsByIdInTenantMock,
}));

vi.mock("@repo/integrations/databricks-vector-search", () => ({
	MAX_QUERY_INDEXES: 2,
	queryDatabricksVectorIndexes: queryDatabricksVectorIndexesMock,
}));

// `Context.current()` throws outside an activity worker. The default mock
// returns undefined (not a throw) which withActivityHeartbeat also treats as
// "no activity context" — good enough for tests that don't care about
// heartbeating. Tests that DO care override this per-case.
vi.mock("@temporalio/activity", () => ({
	Context: { current: contextCurrentMock },
}));

import { executeDatabricksBindingSearch } from "../databricks-binding-utils";
import {
	buildDatabricksKnowledgeToolDefinition,
	databricksKnowledgeToolName,
	executeDatabricksKnowledgeSearch,
	executeDatabricksKnowledgeSearchSafe,
	loadAgentDatabricksBindings,
	mergeDatabricksBindings,
} from "../databricks-knowledge";

describe("Databricks agent knowledge", () => {
	beforeEach(() => {
		findFirstMock.mockReset();
		fetchCredentialsByIdInTenantMock.mockReset();
		queryDatabricksVectorIndexesMock.mockReset();
		contextCurrentMock.mockReset();
	});

	it("returns no bindings for a foreign tenant instance", async () => {
		findFirstMock.mockResolvedValue(null);

		const result = await loadAgentDatabricksBindings({
			instanceId: "instance-from-another-tenant",
			userId: "user-1",
		});

		expect(result).toEqual([]);
		expect(findFirstMock).toHaveBeenCalledWith({
			where: {
				id: "instance-from-another-tenant",
				userId: "user-1",
				organizationId: null,
			},
			include: {
				integrationConfigurations: {
					where: { isEnabled: true },
				},
			},
		});
	});

	it("builds the reviewed tool contract", () => {
		expect(
			buildDatabricksKnowledgeToolDefinition({
				integrationId: "integration-1",
				schema: "knowledge",
				indexNames: ["docs", "tickets"],
			}),
		).toMatchInlineSnapshot(`
			{
			  "description": "Search the team's Databricks vector knowledge base (schema knowledge; indexes: docs, tickets). Use for questions about the indexed corpus; returns relevant text chunks with similarity scores.",
			  "inputSchema": {
			    "properties": {
			      "num_results": {
			        "description": "Max chunks to return (default 8)",
			        "maximum": 50,
			        "minimum": 1,
			        "type": "number",
			      },
			      "query": {
			        "description": "Natural-language search query",
			        "type": "string",
			      },
			    },
			    "required": [
			      "query",
			    ],
			    "type": "object",
			  },
			  "name": "search_databricks_indexes",
			}
		`);
	});

	it("formats chunks, failures, and skipped indexes like the executor", async () => {
		fetchCredentialsByIdInTenantMock.mockResolvedValue({
			DATABRICKS_HOST: "https://workspace.cloud.databricks.com",
		});
		queryDatabricksVectorIndexesMock.mockResolvedValue({
			chunks: [
				{
					indexName: "docs",
					id: "chunk-7",
					content: "The indexed answer.",
					score: 0.9126,
				},
			],
			failures: ["tickets: unavailable"],
			skippedIndexes: ["archive"],
		});

		const result = await executeDatabricksKnowledgeSearch(
			{
				integrationId: "integration-1",
				indexNames: ["docs", "tickets", "archive"],
			},
			{ query: "answer", num_results: 100 },
			{ userId: "user-1", organizationId: "org-1" },
		);

		expect(fetchCredentialsByIdInTenantMock).toHaveBeenCalledWith(
			"integration-1",
			"user-1",
			"org-1",
		);
		expect(queryDatabricksVectorIndexesMock).toHaveBeenCalledWith(
			{ DATABRICKS_HOST: "https://workspace.cloud.databricks.com" },
			{
				indexNames: ["docs", "tickets", "archive"],
				query: "answer",
				numResults: 50,
			},
		);
		expect(result.summary).toBe(
			"[docs #chunk-7] (score 0.913) The indexed answer.\n\n" +
				"⚠ 1 of 2 indexes unavailable: tickets: unavailable\n\n" +
				"⚠ 1 selected index(es) beyond the 2-index limit were not searched: archive",
		);
	});

	describe("activity heartbeat", () => {
		afterEach(() => {
			vi.useRealTimers();
		});

		it("heartbeats while the query is in flight and clears the interval afterward", async () => {
			vi.useFakeTimers();
			const heartbeatMock = vi.fn();
			contextCurrentMock.mockReturnValue({ heartbeat: heartbeatMock });
			fetchCredentialsByIdInTenantMock.mockResolvedValue({
				DATABRICKS_HOST: "https://workspace.cloud.databricks.com",
			});

			let resolveQuery: (value: {
				chunks: never[];
				failures: never[];
				skippedIndexes: never[];
			}) => void = () => {};
			queryDatabricksVectorIndexesMock.mockReturnValue(
				new Promise((resolve) => {
					resolveQuery = resolve;
				}),
			);

			const resultPromise = executeDatabricksKnowledgeSearch(
				{ integrationId: "integration-1", indexNames: ["docs"] },
				{ query: "answer" },
				{ userId: "user-1" },
			);

			// Ticker fires every 10s; 25s in-flight should have heartbeated twice.
			await vi.advanceTimersByTimeAsync(25_000);
			expect(heartbeatMock).toHaveBeenCalledTimes(2);

			resolveQuery({ chunks: [], failures: [], skippedIndexes: [] });
			await resultPromise;

			expect(vi.getTimerCount()).toBe(0);

			// No further heartbeats once the interval has been cleared.
			await vi.advanceTimersByTimeAsync(30_000);
			expect(heartbeatMock).toHaveBeenCalledTimes(2);
		});

		it("completes normally when there is no activity context (e.g. unit tests)", async () => {
			contextCurrentMock.mockImplementation(() => {
				throw new Error("Activity context not initialized");
			});
			fetchCredentialsByIdInTenantMock.mockResolvedValue({
				DATABRICKS_HOST: "https://workspace.cloud.databricks.com",
			});
			queryDatabricksVectorIndexesMock.mockResolvedValue({
				chunks: [],
				failures: [],
				skippedIndexes: [],
			});

			const result = await executeDatabricksKnowledgeSearch(
				{ integrationId: "integration-1", indexNames: ["docs"] },
				{ query: "answer" },
				{ userId: "user-1" },
			);

			expect(result.summary).toBe(
				"No matching content found in the Databricks knowledge base.",
			);
		});
	});

	describe("executeDatabricksKnowledgeSearchSafe", () => {
		it("returns the same structured shape the tool used to build inline on success", async () => {
			fetchCredentialsByIdInTenantMock.mockResolvedValue({
				DATABRICKS_HOST: "https://workspace.cloud.databricks.com",
			});
			queryDatabricksVectorIndexesMock.mockResolvedValue({
				chunks: [
					{
						indexName: "docs",
						id: "chunk-1",
						content: "hi",
						score: 0.5,
					},
				],
				failures: [],
				skippedIndexes: [],
			});

			const result = await executeDatabricksKnowledgeSearchSafe(
				{ integrationId: "integration-1", indexNames: ["docs"] },
				{ query: "answer" },
				{ userId: "user-1" },
			);

			expect(result).toEqual({
				response: "[docs #chunk-1] (score 0.500) hi",
				chunkCount: 1,
				failures: [],
				skippedIndexes: [],
			});
		});

		it("returns a structured failure instead of throwing when every index fails", async () => {
			fetchCredentialsByIdInTenantMock.mockResolvedValue({
				DATABRICKS_HOST: "https://workspace.cloud.databricks.com",
			});
			queryDatabricksVectorIndexesMock.mockRejectedValue(
				new Error("all indexes unavailable"),
			);

			const result = await executeDatabricksKnowledgeSearchSafe(
				{ integrationId: "integration-1", indexNames: ["docs"] },
				{ query: "answer" },
				{ userId: "user-1" },
			);

			expect(result).toEqual({
				error: "all indexes unavailable",
				response:
					"Databricks knowledge search failed: all indexes unavailable",
			});
		});
	});

	describe("executeDatabricksBindingSearch (agent-executor tool runner)", () => {
		it("project-only guest (null credentials) resolves a GRACEFUL empty result — never a thrown tool error", async () => {
			// The membership-gated credential fetcher correctly returns null
			// for a ProjectMember guest with no org Member row. The tool must
			// surface that as the shared executor's silent no-op shape, not
			// pass empty credentials into the query and blow up with
			// "credentials incomplete" in the guest's chat.
			fetchCredentialsByIdInTenantMock.mockResolvedValue(null);

			await expect(
				executeDatabricksBindingSearch(
					{ integrationId: "integration-1", indexNames: ["docs"] },
					{ query: "roadmap" },
					{ userId: "guest-user", organizationId: "org-1" },
				),
			).resolves.toEqual({
				chunks: [],
				failures: [],
				skippedIndexes: [],
				summary:
					"Databricks integration not found or credentials unavailable",
			});
			expect(queryDatabricksVectorIndexesMock).not.toHaveBeenCalled();
		});

		it("a member with credentials still gets real results (extraction did not change behavior)", async () => {
			fetchCredentialsByIdInTenantMock.mockResolvedValue({
				DATABRICKS_HOST: "https://workspace.cloud.databricks.com",
			});
			queryDatabricksVectorIndexesMock.mockResolvedValue({
				chunks: [
					{
						indexName: "docs",
						id: "chunk-1",
						content: "hi",
						score: 0.5,
					},
				],
				failures: [],
				skippedIndexes: [],
			});

			const result = await executeDatabricksBindingSearch(
				{ integrationId: "integration-1", indexNames: ["docs"] },
				{ query: "roadmap", num_results: 3 },
				{ userId: "member-1", organizationId: "org-1" },
			);

			expect(result.chunks).toHaveLength(1);
			expect(result.summary).toBe("[docs #chunk-1] (score 0.500) hi");
			expect(queryDatabricksVectorIndexesMock).toHaveBeenCalledWith(
				{ DATABRICKS_HOST: "https://workspace.cloud.databricks.com" },
				{ indexNames: ["docs"], query: "roadmap", numResults: 3 },
			);
		});
	});

	describe("mergeDatabricksBindings + databricksKnowledgeToolName", () => {
		it("unions index names per integration (deduped, first-seen order)", () => {
			const merged = mergeDatabricksBindings([
				{
					integrationId: "int-1",
					schema: "cat.schema",
					indexNames: ["a", "b"],
				},
				{
					integrationId: "int-1",
					schema: "cat.schema",
					indexNames: ["b", "c"],
				},
			]);

			expect(merged).toEqual([
				{
					integrationId: "int-1",
					schema: "cat.schema",
					indexNames: ["a", "b", "c"],
				},
			]);
		});

		it("keeps distinct integrations separate so each gets its own suffixed tool", () => {
			const merged = mergeDatabricksBindings([
				{ integrationId: "int-1", schema: "s1", indexNames: ["a"] },
				{ integrationId: "int-2", schema: "s2", indexNames: ["b"] },
			]);

			expect(merged).toHaveLength(2);
			// The live bug this fixes: site 3 pushed a hardcoded, unsuffixed
			// name per binding, so the second silently overwrote the first in
			// a keyed record. The shared suffix rule makes names distinct.
			expect(
				merged.map((_, index) => databricksKnowledgeToolName(index)),
			).toEqual([
				"search_databricks_indexes",
				"search_databricks_indexes_2",
			]);
		});

		it("joins differing schemas and drops empty-index bindings", () => {
			const merged = mergeDatabricksBindings([
				{ integrationId: "int-1", schema: "s1", indexNames: ["a"] },
				{ integrationId: "int-1", schema: "s2", indexNames: ["a"] },
				{ integrationId: "int-3", schema: "s3", indexNames: [] },
			]);

			expect(merged).toEqual([
				{
					integrationId: "int-1",
					schema: "s1, s2",
					indexNames: ["a"],
				},
			]);
		});

		it("does NOT pre-truncate a >MAX_QUERY_INDEXES union — the query layer caps and reports skippedIndexes", () => {
			const merged = mergeDatabricksBindings([
				{
					integrationId: "int-1",
					schema: "s",
					indexNames: Array.from({ length: 12 }, (_, i) => `a${i}`),
				},
				{
					integrationId: "int-1",
					schema: "s",
					indexNames: Array.from({ length: 12 }, (_, i) => `b${i}`),
				},
			]);

			expect(merged[0].indexNames).toHaveLength(24);
		});
	});
});
