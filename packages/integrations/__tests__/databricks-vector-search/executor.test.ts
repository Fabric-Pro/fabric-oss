import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	__resetDatabricksVectorSearchCachesForTests,
	listDatabricksVectorIndexes,
	MAX_QUERY_INDEXES,
	queryDatabricksVectorIndexes,
	verifyDatabricksVectorSearchConnection,
} from "../../src/databricks-vector-search/index";

const WORKSPACE_ORIGIN = "https://adb-1234567890123456.7.azuredatabricks.net";
const CREDS = {
	DATABRICKS_HOST: `${WORKSPACE_ORIGIN}/`,
	DATABRICKS_CLIENT_ID: "sp-client",
	DATABRICKS_CLIENT_SECRET: "sp-secret",
};

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

// First call is always the OIDC token exchange
function tokenResponse(): Response {
	return jsonResponse({ access_token: "fake-token", expires_in: 3600 });
}

beforeEach(() => {
	__resetDatabricksVectorSearchCachesForTests();
});

describe("verifyDatabricksVectorSearchConnection", () => {
	it("succeeds when endpoints are listable", async () => {
		const fetchImpl = vi
			.fn()
			.mockResolvedValueOnce(tokenResponse())
			.mockResolvedValueOnce(
				jsonResponse({ endpoints: [{ name: "vs-1" }] }),
			);
		const result = await verifyDatabricksVectorSearchConnection(CREDS, {
			fetchImpl,
		});
		expect(result.success).toBe(true);
		expect(fetchImpl).toHaveBeenNthCalledWith(
			1,
			`${WORKSPACE_ORIGIN}/oidc/v1/token`,
			expect.anything(),
		);
		expect(fetchImpl).toHaveBeenNthCalledWith(
			2,
			`${WORKSPACE_ORIGIN}/api/2.0/vector-search/endpoints`,
			expect.anything(),
		);
	});

	it("does not leak token-response body when the OIDC 200 is not valid JSON", async () => {
		// This function returns `error.message` verbatim to its caller, so a
		// native JSON.parse failure (which quotes the input) would surface the
		// token endpoint's raw body — potentially credential-adjacent content.
		const marker = "secret-marker-do-not-leak";
		const fetchImpl = vi.fn().mockResolvedValueOnce(
			new Response(marker, {
				status: 200,
				headers: { "Content-Type": "application/json" },
			}),
		);

		const result = await verifyDatabricksVectorSearchConnection(CREDS, {
			fetchImpl,
		});

		expect(result.success).toBe(false);
		expect(result.error).toBe(
			"Databricks OAuth response was not valid JSON",
		);
		expect(result.error).not.toContain(marker);
		// Also rule out the parser's own phrasing reaching the caller.
		expect(result.error).not.toMatch(/is not valid JSON$/);
		expect(result.error).not.toContain("Unexpected token");
	});

	it("does not leak token-response body when access_token is missing", async () => {
		const marker = "leaky-field-value";
		const fetchImpl = vi
			.fn()
			.mockResolvedValueOnce(jsonResponse({ other: marker }));

		const result = await verifyDatabricksVectorSearchConnection(CREDS, {
			fetchImpl,
		});

		expect(result.success).toBe(false);
		expect(result.error).toBe(
			"Databricks OAuth response did not include access_token",
		);
		expect(result.error).not.toContain(marker);
	});

	it("fails without credentials", async () => {
		const result = await verifyDatabricksVectorSearchConnection({});
		expect(result.success).toBe(false);
		expect(result.error).toMatch(/host|credential/i);
	});

	it.each([
		["HTTP", "http://adb-1234567890123456.7.azuredatabricks.net"],
		["IPv4 literal", "https://127.0.0.1"],
		["IPv6 literal", "https://[::1]"],
		["localhost", "https://localhost"],
		["path", "https://adb-1234567890123456.7.azuredatabricks.net/api"],
		[
			"query",
			"https://adb-1234567890123456.7.azuredatabricks.net?target=internal",
		],
		[
			"fragment",
			"https://adb-1234567890123456.7.azuredatabricks.net#target",
		],
		["userinfo", "https://user@adb-1234567890123456.7.azuredatabricks.net"],
		[
			"non-default port",
			"https://adb-1234567890123456.7.azuredatabricks.net:8443",
		],
		[
			"lookalike domain",
			"https://adb-1234567890123456.7.azuredatabricks.net.example.com",
		],
		["no-dot suffix lookalike", "https://evilazuredatabricks.net"],
	])("rejects a %s host", async (_case, host) => {
		const fetchImpl = vi.fn();
		const result = await verifyDatabricksVectorSearchConnection(
			{ ...CREDS, DATABRICKS_HOST: host },
			{ fetchImpl },
		);
		expect(result).toEqual({
			success: false,
			error: expect.stringMatching(/HTTPS Databricks workspace origin/),
		});
		expect(fetchImpl).not.toHaveBeenCalled();
	});
});

describe("listDatabricksVectorIndexes", () => {
	it("lists indexes across endpoints and derives schemas", async () => {
		const fetchImpl = vi
			.fn()
			.mockResolvedValueOnce(tokenResponse())
			.mockResolvedValueOnce(
				jsonResponse({ endpoints: [{ name: "vs-1" }] }),
			)
			.mockResolvedValueOnce(
				jsonResponse({
					vector_indexes: [
						{
							name: "cat.schema_a.idx1",
							endpoint_name: "vs-1",
							index_type: "DELTA_SYNC",
							primary_key: "id",
						},
					],
				}),
			)
			.mockResolvedValueOnce(
				jsonResponse({
					primary_key: "id",
					status: { ready: true },
					delta_sync_index_spec: {
						embedding_source_columns: [{ name: "content" }],
					},
				}),
			);
		const indexes = await listDatabricksVectorIndexes(CREDS, { fetchImpl });
		expect(indexes).toEqual([
			{
				name: "cat.schema_a.idx1",
				schema: "cat.schema_a",
				endpointName: "vs-1",
				indexType: "DELTA_SYNC",
			},
		]);
	});

	it("excludes direct-access and Delta Sync indexes without managed embeddings", async () => {
		const detailRequests: string[] = [];
		const fetchImpl = vi.fn(async (input: string | URL | Request) => {
			const url = String(input);
			if (url.endsWith("/oidc/v1/token")) {
				return tokenResponse();
			}
			if (url.endsWith("/vector-search/endpoints")) {
				return jsonResponse({ endpoints: [{ name: "vs-1" }] });
			}
			if (url.includes("/vector-search/indexes?endpoint_name=")) {
				return jsonResponse({
					vector_indexes: [
						{
							name: "cat.schema_a.managed",
							endpoint_name: "vs-1",
							index_type: "DELTA_SYNC",
						},
						{
							name: "cat.schema_a.self_managed",
							endpoint_name: "vs-1",
							index_type: "DELTA_SYNC",
						},
						{
							name: "cat.schema_a.direct",
							endpoint_name: "vs-1",
							index_type: "DIRECT_ACCESS",
						},
					],
				});
			}
			detailRequests.push(url);
			if (url.endsWith("/cat.schema_a.managed")) {
				return jsonResponse({
					primary_key: "id",
					status: { ready: true },
					delta_sync_index_spec: {
						embedding_source_columns: [{ name: "content" }],
					},
				});
			}
			if (url.endsWith("/cat.schema_a.self_managed")) {
				return jsonResponse({
					primary_key: "id",
					status: { ready: true },
					delta_sync_index_spec: {
						embedding_vector_columns: [{ name: "embedding" }],
					},
				});
			}
			throw new Error(`Unexpected URL: ${url}`);
		});

		const indexes = await listDatabricksVectorIndexes(CREDS, { fetchImpl });

		expect(indexes).toEqual([
			{
				name: "cat.schema_a.managed",
				schema: "cat.schema_a",
				endpointName: "vs-1",
				indexType: "DELTA_SYNC",
			},
		]);
		expect(detailRequests).toHaveLength(2);
		expect(detailRequests.join(" ")).not.toContain("cat.schema_a.direct");
	});

	it("follows next_page_token across endpoint and index list pages", async () => {
		const fetchImpl = vi.fn(async (input: string | URL | Request) => {
			const url = String(input);
			if (url.endsWith("/oidc/v1/token")) {
				return tokenResponse();
			}
			if (url.endsWith("/vector-search/endpoints")) {
				return jsonResponse({
					endpoints: [{ name: "vs-1" }],
					next_page_token: "endpoints-page-2",
				});
			}
			if (url.includes("page_token=endpoints-page-2")) {
				return jsonResponse({ endpoints: [{ name: "vs-2" }] });
			}
			if (
				url.includes("/vector-search/indexes?endpoint_name=vs-1") &&
				!url.includes("page_token")
			) {
				return jsonResponse({
					vector_indexes: [
						{
							name: "cat.schema_a.idx1",
							endpoint_name: "vs-1",
							index_type: "DELTA_SYNC",
						},
					],
					next_page_token: "vs-1-page-2",
				});
			}
			if (
				url.includes("endpoint_name=vs-1") &&
				url.includes("page_token=vs-1-page-2")
			) {
				return jsonResponse({
					vector_indexes: [
						{
							name: "cat.schema_a.idx2",
							endpoint_name: "vs-1",
							index_type: "DELTA_SYNC",
						},
					],
				});
			}
			if (url.includes("endpoint_name=vs-2")) {
				return jsonResponse({
					vector_indexes: [
						{
							name: "cat.schema_b.idx1",
							endpoint_name: "vs-2",
							index_type: "DELTA_SYNC",
						},
					],
				});
			}
			// index detail lookups — mark everything eligible
			return jsonResponse({
				primary_key: "id",
				status: { ready: true },
				delta_sync_index_spec: {
					embedding_source_columns: [{ name: "content" }],
				},
			});
		});

		const indexes = await listDatabricksVectorIndexes(CREDS, { fetchImpl });

		expect(indexes.map((i) => i.name).sort()).toEqual([
			"cat.schema_a.idx1",
			"cat.schema_a.idx2",
			"cat.schema_b.idx1",
		]);
	});

	it("throws when a collection's pagination does not terminate", async () => {
		let page = 0;
		const fetchImpl = vi.fn(async (input: string | URL | Request) => {
			const url = String(input);
			if (url.endsWith("/oidc/v1/token")) {
				return tokenResponse();
			}
			if (url.includes("/vector-search/endpoints")) {
				page++;
				return jsonResponse({
					endpoints: [],
					next_page_token: `page-${page}`,
				});
			}
			throw new Error(`Unexpected URL: ${url}`);
		});

		await expect(
			listDatabricksVectorIndexes(CREDS, { fetchImpl }),
		).rejects.toThrow(/pagination did not terminate/);
	});
});

describe("queryDatabricksVectorIndexes", () => {
	it("queries an index and maps chunks with scores", async () => {
		const fetchImpl = vi
			.fn()
			.mockResolvedValueOnce(tokenResponse())
			// get-index (column discovery)
			.mockResolvedValueOnce(
				jsonResponse({
					primary_key: "id",
					status: { ready: true },
					delta_sync_index_spec: {
						embedding_source_columns: [{ name: "content" }],
					},
				}),
			)
			// query
			.mockResolvedValueOnce(
				jsonResponse({
					manifest: {
						columns: [
							{ name: "id" },
							{ name: "content" },
							{ name: "score" },
						],
					},
					result: { data_array: [["row-1", "hello world", 0.87]] },
				}),
			);
		const result = await queryDatabricksVectorIndexes(CREDS, {
			indexNames: ["cat.schema_a.idx1"],
			query: "hello",
			numResults: 5,
			fetchImpl,
		});
		expect(result.chunks).toEqual([
			{
				indexName: "cat.schema_a.idx1",
				id: "row-1",
				content: "hello world",
				score: 0.87,
			},
		]);
		expect(result.failures).toEqual([]);
	});

	it("records a per-index failure when the query manifest lacks the expected columns", async () => {
		const fetchImpl = vi
			.fn()
			.mockResolvedValueOnce(tokenResponse())
			// get-index (column discovery)
			.mockResolvedValueOnce(
				jsonResponse({
					primary_key: "id",
					status: { ready: true },
					delta_sync_index_spec: {
						embedding_source_columns: [{ name: "content" }],
					},
				}),
			)
			// query — manifest is missing the expected id/content columns
			.mockResolvedValueOnce(
				jsonResponse({
					manifest: { columns: [{ name: "unexpected" }] },
					result: { data_array: [["row-1", "hello world", 0.87]] },
				}),
			);
		await expect(
			queryDatabricksVectorIndexes(CREDS, {
				indexNames: ["cat.schema_a.idx1"],
				query: "hello",
				fetchImpl,
			}),
		).rejects.toThrow(/missing expected columns id\/content/);
	});

	it("surfaces per-index failures as thrown errors when all indexes fail", async () => {
		const fetchImpl = vi
			.fn()
			.mockResolvedValueOnce(tokenResponse())
			.mockResolvedValue(jsonResponse({ message: "boom" }, 500));
		await expect(
			queryDatabricksVectorIndexes(CREDS, {
				indexNames: ["cat.schema_a.idx1"],
				query: "hello",
				fetchImpl,
			}),
		).rejects.toThrow();
	});

	it("does not throw when one index fails but another succeeds with zero rows", async () => {
		const fetchImpl = vi.fn().mockImplementation(async (url: string) => {
			// Token exchange (OIDC endpoint)
			if (url.includes("/oidc/v1/token")) {
				return tokenResponse();
			}
			// Get-index for "bad" index — return 500
			if (url.includes("/vector-search/indexes/cat.schema_a.bad")) {
				return jsonResponse({ message: "boom" }, 500);
			}
			// Get-index for "empty" index — return valid metadata
			if (
				url.includes("/vector-search/indexes") &&
				url.includes("cat.schema_a.empty") &&
				!url.includes("/query")
			) {
				return jsonResponse({
					primary_key: "id",
					status: { ready: true },
					delta_sync_index_spec: {
						embedding_source_columns: [{ name: "content" }],
					},
				});
			}
			// Query for "empty" index — return no rows
			if (
				url.includes("/vector-search/indexes/cat.schema_a.empty/query")
			) {
				return jsonResponse({
					manifest: {
						columns: [
							{ name: "id" },
							{ name: "content" },
							{ name: "score" },
						],
					},
					result: { data_array: [] },
				});
			}
			throw new Error(`Unexpected URL: ${url}`);
		});
		const result = await queryDatabricksVectorIndexes(CREDS, {
			indexNames: ["cat.schema_a.bad", "cat.schema_a.empty"],
			query: "hello",
			fetchImpl,
		});
		expect(result.chunks).toEqual([]);
		expect(result.failures).toHaveLength(1);
		expect(result.failures[0]).toContain("cat.schema_a.bad");
	});

	it.each([
		[0, 1],
		[-5, 1],
		[10_000, 50],
		[Number.NaN, 8],
		[undefined, 8],
	])("normalizes numResults %s to %s", async (numResults, expected) => {
		let queryBody: { num_results?: number } | undefined;
		const fetchImpl = vi.fn(
			async (input: string | URL | Request, init?: RequestInit) => {
				const url = String(input);
				if (url.endsWith("/oidc/v1/token")) {
					return tokenResponse();
				}
				if (url.endsWith("/query")) {
					queryBody = JSON.parse(String(init?.body));
					return jsonResponse({
						manifest: {
							columns: [
								{ name: "id" },
								{ name: "content" },
								{ name: "score" },
							],
						},
						result: { data_array: [] },
					});
				}
				return jsonResponse({
					primary_key: "id",
					status: { ready: true },
					delta_sync_index_spec: {
						embedding_source_columns: [{ name: "content" }],
					},
				});
			},
		);

		await queryDatabricksVectorIndexes(CREDS, {
			indexNames: ["cat.schema_a.idx1"],
			query: "hello",
			numResults,
			fetchImpl,
		});

		expect(queryBody?.num_results).toBe(expected);
	});

	it("queries a duplicated index name only once", async () => {
		const queryCalls: string[] = [];
		const fetchImpl = vi.fn(async (input: string | URL | Request) => {
			const url = String(input);
			if (url.endsWith("/oidc/v1/token")) {
				return tokenResponse();
			}
			if (url.endsWith("/query")) {
				queryCalls.push(url);
				return jsonResponse({
					manifest: {
						columns: [
							{ name: "id" },
							{ name: "content" },
							{ name: "score" },
						],
					},
					result: { data_array: [] },
				});
			}
			return jsonResponse({
				primary_key: "id",
				status: { ready: true },
				delta_sync_index_spec: {
					embedding_source_columns: [{ name: "content" }],
				},
			});
		});

		const result = await queryDatabricksVectorIndexes(CREDS, {
			indexNames: [
				"cat.schema_a.idx1",
				"cat.schema_a.idx1",
				"cat.schema_a.idx1",
			],
			query: "hello",
			fetchImpl,
		});

		expect(queryCalls).toHaveLength(1);
		expect(result.failures).toEqual([]);
	});

	it("caps the query fan-out at 16 indexes and returns the skipped index names", async () => {
		const queryCalls: string[] = [];
		const fetchImpl = vi.fn(async (input: string | URL | Request) => {
			const url = String(input);
			if (url.endsWith("/oidc/v1/token")) {
				return tokenResponse();
			}
			if (url.endsWith("/query")) {
				queryCalls.push(url);
				return jsonResponse({
					manifest: {
						columns: [
							{ name: "id" },
							{ name: "content" },
							{ name: "score" },
						],
					},
					result: { data_array: [] },
				});
			}
			return jsonResponse({
				primary_key: "id",
				status: { ready: true },
				delta_sync_index_spec: {
					embedding_source_columns: [{ name: "content" }],
				},
			});
		});

		const indexNames = Array.from(
			{ length: 20 },
			(_, i) => `cat.schema_a.idx${i}`,
		);

		const result = await queryDatabricksVectorIndexes(CREDS, {
			indexNames,
			query: "hello",
			fetchImpl,
		});

		expect(queryCalls).toHaveLength(MAX_QUERY_INDEXES);
		expect(result.failures).toEqual([]);
		expect(result.skippedIndexes).toEqual(
			indexNames.slice(MAX_QUERY_INDEXES),
		);
		expect(result.skippedIndexes).toHaveLength(4);
	});
});

describe("index metadata caching + request aborting", () => {
	function urlOf(input: unknown): string {
		return typeof input === "string" ? input : String(input);
	}

	it("coalesces concurrent cold-cache callers onto ONE metadata GET", async () => {
		let metaGets = 0;
		const fetchImpl = vi.fn(
			async (input: string | URL | Request, init?: RequestInit) => {
				const url = urlOf(input);
				if (url.endsWith("/oidc/v1/token")) {
					return tokenResponse();
				}
				if (url.includes("/query")) {
					const body = JSON.parse(String(init?.body ?? "{}"));
					return jsonResponse({
						manifest: {
							columns: [
								{ name: "id" },
								{ name: "content" },
								{ name: "score" },
							],
						},
						result: {
							data_array: [
								[`row-${body.query_text}`, "text", 0.5],
							],
						},
					});
				}
				// index detail (metadata) GET
				metaGets++;
				return jsonResponse({
					primary_key: "id",
					status: { ready: true },
					delta_sync_index_spec: {
						embedding_source_columns: [{ name: "content" }],
					},
				});
			},
		);

		// Three concurrent calls against the same index — the RRF branch's
		// exact shape. Before the in-flight promise cache, this issued three
		// redundant metadata GETs.
		const [a, b, c] = await Promise.all([
			queryDatabricksVectorIndexes(CREDS, {
				indexNames: ["cat.schema_a.idx1"],
				query: "q1",
				fetchImpl,
			}),
			queryDatabricksVectorIndexes(CREDS, {
				indexNames: ["cat.schema_a.idx1"],
				query: "q2",
				fetchImpl,
			}),
			queryDatabricksVectorIndexes(CREDS, {
				indexNames: ["cat.schema_a.idx1"],
				query: "q3",
				fetchImpl,
			}),
		]);

		expect(metaGets).toBe(1);
		expect(a.failures).toEqual([]);
		expect(b.failures).toEqual([]);
		expect(c.failures).toEqual([]);
	});

	it("evicts the cached metadata promise on rejection so a failed fetch doesn't poison the cache", async () => {
		let metaGets = 0;
		const fetchImpl = vi.fn(
			async (input: string | URL | Request, _init?: RequestInit) => {
				const url = urlOf(input);
				if (url.endsWith("/oidc/v1/token")) {
					return tokenResponse();
				}
				if (url.includes("/query")) {
					return jsonResponse({
						manifest: {
							columns: [
								{ name: "id" },
								{ name: "content" },
								{ name: "score" },
							],
						},
						result: { data_array: [["row-1", "text", 0.5]] },
					});
				}
				metaGets++;
				if (metaGets === 1) {
					return jsonResponse({ message: "boom" }, 500);
				}
				return jsonResponse({
					primary_key: "id",
					status: { ready: true },
					delta_sync_index_spec: {
						embedding_source_columns: [{ name: "content" }],
					},
				});
			},
		);

		// First call: metadata GET fails → the whole (single-index) query
		// fails. The rejected promise must NOT stay cached for its TTL.
		await expect(
			queryDatabricksVectorIndexes(CREDS, {
				indexNames: ["cat.schema_a.idx1"],
				query: "q1",
				fetchImpl,
			}),
		).rejects.toThrow(/failed for all indexes/);

		// Second call retries the metadata GET and succeeds.
		const result = await queryDatabricksVectorIndexes(CREDS, {
			indexNames: ["cat.schema_a.idx1"],
			query: "q2",
			fetchImpl,
		});
		expect(metaGets).toBe(2);
		expect(result.chunks).toHaveLength(1);
	});

	it("aborting the caller's signal aborts the UNDERLYING search request, not just the caller's promise", async () => {
		const controller = new AbortController();
		let searchSignalAborted = false;
		let searchStarted: (() => void) | undefined;
		const searchStartedPromise = new Promise<void>((resolve) => {
			searchStarted = resolve;
		});

		const fetchImpl = vi.fn(
			async (input: string | URL | Request, init?: RequestInit) => {
				const url = urlOf(input);
				if (url.endsWith("/oidc/v1/token")) {
					return tokenResponse();
				}
				if (url.includes("/query")) {
					// Emulate fetch abort semantics: hang until the request's
					// signal fires, then reject like a real aborted fetch.
					searchStarted?.();
					return new Promise<Response>((_resolve, reject) => {
						init?.signal?.addEventListener(
							"abort",
							() => {
								searchSignalAborted = true;
								reject(
									new DOMException(
										"This operation was aborted",
										"AbortError",
									),
								);
							},
							{ once: true },
						);
					});
				}
				return jsonResponse({
					primary_key: "id",
					status: { ready: true },
					delta_sync_index_spec: {
						embedding_source_columns: [{ name: "content" }],
					},
				});
			},
		);

		const pending = queryDatabricksVectorIndexes(CREDS, {
			indexNames: ["cat.schema_a.idx1"],
			query: "hello",
			fetchImpl,
			signal: controller.signal,
		});

		await searchStartedPromise;
		controller.abort();

		// Single index, aborted → the whole call rejects…
		await expect(pending).rejects.toThrow(/failed for all indexes/);
		// …and the HTTP request itself observed the abort (proving the
		// signal reached fetch, not merely that the caller stopped waiting).
		expect(searchSignalAborted).toBe(true);
	});
});
