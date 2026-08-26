/**
 * Databricks branch of `retrieveRelevantContextsForSpec` — fusion quality,
 * gating, and outage semantics.
 *
 * The ranking assertions here are the guardrails the plan called out
 * explicitly: Databricks has NO relevance floor of any kind (it always
 * returns `num_results` rows), and RRF is rank-based, so an irrelevant or
 * boilerplate external chunk recurring across sub-queries can out-rank a
 * strong internal hit. The per-source quota + relative floor bound that —
 * these tests fail if either mitigation is dropped.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
	getProviderConfigMock,
	generateEmbeddingsMock,
	searchMock,
	chunkTextMock,
	applySummaryMock,
	getContextMock,
	loadBindingMock,
	fetchCredsMock,
	queryDbxMock,
} = vi.hoisted(() => ({
	getProviderConfigMock: vi.fn(),
	generateEmbeddingsMock: vi.fn(),
	searchMock: vi.fn(),
	chunkTextMock: vi.fn(),
	applySummaryMock: vi.fn(),
	getContextMock: vi.fn(),
	loadBindingMock: vi.fn(),
	fetchCredsMock: vi.fn(),
	queryDbxMock: vi.fn(),
}));

vi.mock("@repo/ai", () => ({
	getRAGProviderConfig: getProviderConfigMock,
}));

vi.mock("@repo/database", () => ({
	getRetrievableContextById: getContextMock,
	loadProjectDatabricksKnowledgeBinding: loadBindingMock,
	fetchCredentialsByIdInTenant: fetchCredsMock,
}));

vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../../chunking", () => ({ chunkText: chunkTextMock }));
vi.mock("../../embedding", () => ({
	generateEmbeddings: generateEmbeddingsMock,
}));
vi.mock("../../embedding/sparse", () => ({
	generateSparseVector: vi.fn(() => ({ indices: [], values: [] })),
}));
vi.mock("../store", () => ({ searchSimilarProjectContexts: searchMock }));
vi.mock("../summary-injection", () => ({
	applyContextSummary: applySummaryMock,
}));
// Dynamic import target — vi.mock covers `await import(...)` too.
vi.mock("@repo/integrations/databricks-vector-search", () => ({
	MAX_QUERY_INDEXES: 16,
	queryDatabricksVectorIndexes: queryDbxMock,
}));

import {
	RetrievalUnavailableError,
	retrieveRelevantContextsForSpec,
} from "../retrieve-for-spec";

const BASE = {
	projectId: "proj_1",
	userId: "user_1",
	organizationId: "org_1",
	specMarkdown: "# PRD\n\nThe rollout plan.",
	baselineDate: new Date("2026-06-01T00:00:00Z"),
};

const BINDING = {
	integrationId: "int_1",
	schema: "cat.schema",
	indexNames: ["cat.schema.idx_a"],
};

function chunksOf(n: number) {
	return Array.from({ length: n }, (_, i) => ({ content: `chunk ${i}` }));
}

function qdrantHit(contextId: string, score = 0.8) {
	return { contextId, score, content: `qdrant chunk for ${contextId}` };
}

function dbxChunk(
	indexName: string,
	id: string,
	score: number,
	content?: string,
) {
	return {
		indexName,
		id,
		score,
		content: content ?? `dbx ${indexName}#${id}`,
	};
}

function hydratedContext(id: string) {
	return {
		id,
		type: "MEETING_TRANSCRIPT",
		content: `full transcript ${id}`,
		createdAt: new Date("2026-07-01T00:00:00Z"),
		metadata: null,
		originalFilename: null,
		sourceUrl: null,
		sourceTitle: `Meeting ${id}`,
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.stubEnv("FABRIC_FEATURE_PROJECT_DATABRICKS_KNOWLEDGE", "true");
	getProviderConfigMock.mockResolvedValue({ provider: "openai" });
	chunkTextMock.mockReturnValue(chunksOf(2));
	generateEmbeddingsMock.mockImplementation(async (texts: string[]) => ({
		embeddings: texts.map(() => [0.1, 0.2, 0.3]),
	}));
	searchMock.mockResolvedValue([]);
	applySummaryMock.mockImplementation(async (list: unknown[]) => list);
	getContextMock.mockImplementation(async (id: string) =>
		hydratedContext(id),
	);
	loadBindingMock.mockResolvedValue(BINDING);
	fetchCredsMock.mockResolvedValue({ DATABRICKS_HOST: "https://x" });
	queryDbxMock.mockResolvedValue({
		chunks: [],
		failures: [],
		skippedIndexes: [],
	});
});

afterEach(() => {
	vi.unstubAllEnvs();
});

describe("gating", () => {
	it("flag off: never loads the binding or queries Databricks — retrieval unchanged", async () => {
		vi.stubEnv("FABRIC_FEATURE_PROJECT_DATABRICKS_KNOWLEDGE", "false");
		searchMock.mockResolvedValue([qdrantHit("ctx_1")]);

		const results = await retrieveRelevantContextsForSpec(BASE);

		expect(loadBindingMock).not.toHaveBeenCalled();
		expect(queryDbxMock).not.toHaveBeenCalled();
		expect(results.map((r) => r.id)).toEqual(["ctx_1"]);
	});

	it("excludeDocumentChunks (unattended sweep): branch skipped ENTIRELY even with the flag on", async () => {
		searchMock.mockResolvedValue([qdrantHit("ctx_1")]);
		queryDbxMock.mockResolvedValue({
			chunks: [dbxChunk("cat.schema.idx_a", "1", 0.9)],
			failures: [],
			skippedIndexes: [],
		});

		const results = await retrieveRelevantContextsForSpec({
			...BASE,
			excludeDocumentChunks: true,
		});

		expect(loadBindingMock).not.toHaveBeenCalled();
		expect(queryDbxMock).not.toHaveBeenCalled();
		expect(results.every((r) => r.type !== "EXTERNAL_INDEX")).toBe(true);
	});

	it("no binding: Databricks is never queried", async () => {
		loadBindingMock.mockResolvedValue(null);
		searchMock.mockResolvedValue([qdrantHit("ctx_1")]);

		const results = await retrieveRelevantContextsForSpec(BASE);

		expect(queryDbxMock).not.toHaveBeenCalled();
		expect(results.map((r) => r.id)).toEqual(["ctx_1"]);
	});
});

describe("cost controls", () => {
	it("caps the Databricks fan-out at 3 sub-queries even for a 12-chunk spec", async () => {
		chunkTextMock.mockReturnValue(chunksOf(12));

		await retrieveRelevantContextsForSpec(BASE);

		expect(queryDbxMock).toHaveBeenCalledTimes(3);
		// Qdrant fan-out is unchanged: one search per spec chunk.
		expect(searchMock).toHaveBeenCalledTimes(12);
	});
});

describe("fusion quality", () => {
	it("irrelevant-full-result-list at PRODUCTION score scale: the rank cut bounds a full page of clustered RRF-fused scores", async () => {
		// Qdrant: ctx_1 matches rank 0 in BOTH sub-queries (RRF 2/60).
		searchMock.mockResolvedValue([qdrantHit("ctx_1")]);
		// Databricks HYBRID returns RRF-fused scores that cluster tightly —
		// rank 1 ≈ 0.033 … rank 8 ≈ 0.028. A ratio floor (0.5×) can never
		// discriminate at this scale (0.028 ≥ 0.033 × 0.5), so the RANK cut
		// is what has to bound the page.
		queryDbxMock.mockResolvedValue({
			chunks: Array.from({ length: 8 }, (_, i) =>
				dbxChunk("cat.schema.idx_a", `row_${i}`, 0.033 - i * 0.0007),
			),
			failures: [],
			skippedIndexes: [],
		});

		const results = await retrieveRelevantContextsForSpec(BASE);

		const external = results.filter((r) => r.type === "EXTERNAL_INDEX");
		// Only the top-4 per sub-query survive the rank cut (both sub-queries
		// return the same rows, so 4 distinct externals total)…
		expect(external.map((r) => r.id)).toEqual([
			"databricks:int_1:cat.schema.idx_a:row_0",
			"databricks:int_1:cat.schema.idx_a:row_1",
			"databricks:int_1:cat.schema.idx_a:row_2",
			"databricks:int_1:cat.schema.idx_a:row_3",
		]);
		// …and the internal hit is not displaced from the top.
		expect(results[0].id).toBe("ctx_1");
	});

	it("relative floor (defense-in-depth): a degenerate wide spread still drops the filler", async () => {
		searchMock.mockResolvedValue([qdrantHit("ctx_1")]);
		// Raw-similarity-scale spread (NOT the production HYBRID shape):
		// one real match at 0.9, filler at 0.3 < 0.9 × 0.5.
		queryDbxMock.mockResolvedValue({
			chunks: [
				dbxChunk("cat.schema.idx_a", "1", 0.9),
				...Array.from({ length: 3 }, (_, i) =>
					dbxChunk("cat.schema.idx_a", `filler_${i}`, 0.3),
				),
			],
			failures: [],
			skippedIndexes: [],
		});

		const results = await retrieveRelevantContextsForSpec(BASE);

		const external = results.filter((r) => r.type === "EXTERNAL_INDEX");
		expect(external.map((r) => r.id)).toEqual([
			"databricks:int_1:cat.schema.idx_a:1",
		]);
	});

	it("drops non-positive and non-finite scores outright (a whole page of them yields no external results, not filler)", async () => {
		searchMock.mockResolvedValue([qdrantHit("ctx_1")]);
		queryDbxMock.mockResolvedValue({
			chunks: [
				dbxChunk("cat.schema.idx_a", "z1", 0),
				dbxChunk("cat.schema.idx_a", "z2", -0.4),
				dbxChunk("cat.schema.idx_a", "z3", Number.NaN),
			],
			failures: [],
			skippedIndexes: [],
		});

		const results = await retrieveRelevantContextsForSpec(BASE);

		expect(results.filter((r) => r.type === "EXTERNAL_INDEX")).toEqual([]);
		// Score-less garbage is not an outage: the internal results stand.
		expect(results.map((r) => r.id)).toEqual(["ctx_1"]);
	});

	it.each([[1], [2]])(
		"honors the exact ⌊topK/3⌋ quota: topK=%i has quota 0, so the branch is skipped entirely",
		async (topK) => {
			searchMock.mockResolvedValue([qdrantHit("ctx_1")]);
			queryDbxMock.mockResolvedValue({
				chunks: [dbxChunk("cat.schema.idx_a", "1", 0.9)],
				failures: [],
				skippedIndexes: [],
			});

			const results = await retrieveRelevantContextsForSpec({
				...BASE,
				topK,
			});

			expect(loadBindingMock).not.toHaveBeenCalled();
			expect(queryDbxMock).not.toHaveBeenCalled();
			expect(results.filter((r) => r.type === "EXTERNAL_INDEX")).toEqual(
				[],
			);
		},
	);

	it("repeated boilerplate across queries cannot flood the list: external share is quota-capped at ⌊topK/3⌋", async () => {
		searchMock.mockResolvedValue([qdrantHit("ctx_1")]);
		// Every sub-query returns the same 4 similar-scoring external chunks
		// — each accumulates one RRF contribution PER query.
		queryDbxMock.mockResolvedValue({
			chunks: [
				dbxChunk("cat.schema.idx_a", "b1", 0.9),
				dbxChunk("cat.schema.idx_a", "b2", 0.85),
				dbxChunk("cat.schema.idx_a", "b3", 0.8),
				dbxChunk("cat.schema.idx_a", "b4", 0.75),
			],
			failures: [],
			skippedIndexes: [],
		});

		const results = await retrieveRelevantContextsForSpec({
			...BASE,
			topK: 3,
		});

		const external = results.filter((r) => r.type === "EXTERNAL_INDEX");
		expect(external.length).toBeLessThanOrEqual(1); // ⌊3/3⌋
		// The Qdrant hit survives despite the external chunks' accumulated
		// rank weight.
		expect(results.some((r) => r.id === "ctx_1")).toBe(true);
	});

	it("multi-index merge: identical primary keys across indexes stay distinct (namespaced keys)", async () => {
		queryDbxMock.mockResolvedValue({
			chunks: [
				dbxChunk("cat.schema.idx_a", "1", 0.9),
				dbxChunk("cat.schema.idx_b", "1", 0.8),
			],
			failures: [],
			skippedIndexes: [],
		});

		const results = await retrieveRelevantContextsForSpec(BASE);

		const ids = results
			.filter((r) => r.type === "EXTERNAL_INDEX")
			.map((r) => r.id);
		expect(ids).toContain("databricks:int_1:cat.schema.idx_a:1");
		expect(ids).toContain("databricks:int_1:cat.schema.idx_b:1");
	});

	it("never hydrates Databricks entries from Postgres (partition before hydrate)", async () => {
		searchMock.mockResolvedValue([qdrantHit("ctx_1")]);
		queryDbxMock.mockResolvedValue({
			chunks: [dbxChunk("cat.schema.idx_a", "42", 0.9)],
			failures: [],
			skippedIndexes: [],
		});

		await retrieveRelevantContextsForSpec(BASE);

		for (const call of getContextMock.mock.calls) {
			expect(call[0]).not.toMatch(/^databricks:/);
		}
	});

	it("applies the same content cap as the Postgres branch to external content", async () => {
		queryDbxMock.mockResolvedValue({
			chunks: [
				dbxChunk("cat.schema.idx_a", "1", 0.9, "x".repeat(10_000)),
			],
			failures: [],
			skippedIndexes: [],
		});

		const results = await retrieveRelevantContextsForSpec(BASE);

		const external = results.find((r) => r.type === "EXTERNAL_INDEX");
		expect(external?.content.length).toBe(3000 + 3); // cap + "..."
		expect(external?.content.endsWith("...")).toBe(true);
	});

	it("labels external hits honestly: type, sourceTitle, and provenance metadata", async () => {
		queryDbxMock.mockResolvedValue({
			chunks: [dbxChunk("cat.schema.idx_a", "7", 0.9)],
			failures: [],
			skippedIndexes: [],
		});

		const results = await retrieveRelevantContextsForSpec(BASE);

		const external = results.find((r) => r.type === "EXTERNAL_INDEX");
		expect(external).toBeDefined();
		expect(external?.sourceTitle).toBe("Databricks: cat.schema.idx_a");
		expect(external?.metadata).toMatchObject({
			isExternalIndex: true,
			integrationId: "int_1",
			indexName: "cat.schema.idx_a",
			externalId: "7",
		});
	});
});

describe("throwOnRetrievalError — whole-source outage", () => {
	it("throws RetrievalUnavailableError when every Databricks query fails for an enabled binding", async () => {
		searchMock.mockResolvedValue([qdrantHit("ctx_1")]);
		queryDbxMock.mockRejectedValue(new Error("workspace unreachable"));

		await expect(
			retrieveRelevantContextsForSpec({
				...BASE,
				throwOnRetrievalError: true,
			}),
		).rejects.toBeInstanceOf(RetrievalUnavailableError);
	});

	it("throws when credentials resolve to null (which does not itself throw)", async () => {
		fetchCredsMock.mockResolvedValue(null);

		await expect(
			retrieveRelevantContextsForSpec({
				...BASE,
				throwOnRetrievalError: true,
			}),
		).rejects.toBeInstanceOf(RetrievalUnavailableError);
	});

	it("does NOT throw when the project simply has no binding", async () => {
		loadBindingMock.mockResolvedValue(null);
		searchMock.mockResolvedValue([qdrantHit("ctx_1")]);

		await expect(
			retrieveRelevantContextsForSpec({
				...BASE,
				throwOnRetrievalError: true,
			}),
		).resolves.toHaveLength(1);
	});

	it("interactive callers (flag unset) degrade to internal-only results on a whole-source failure", async () => {
		searchMock.mockResolvedValue([qdrantHit("ctx_1")]);
		queryDbxMock.mockRejectedValue(new Error("workspace unreachable"));

		const results = await retrieveRelevantContextsForSpec(BASE);

		expect(results.map((r) => r.id)).toEqual(["ctx_1"]);
	});

	it("times out the branch after its wall-clock budget AND aborts the underlying Databricks calls", async () => {
		vi.useFakeTimers();
		try {
			searchMock.mockResolvedValue([qdrantHit("ctx_1")]);
			let capturedSignal: AbortSignal | undefined;
			queryDbxMock.mockImplementation(
				(_creds: unknown, args: { signal?: AbortSignal }) => {
					capturedSignal = args.signal;
					// Hang forever — an unresponsive workspace.
					return new Promise(() => {});
				},
			);

			const pending = retrieveRelevantContextsForSpec(BASE);
			await vi.advanceTimersByTimeAsync(15_000);
			const results = await pending;

			// The caller moved on with internal-only results…
			expect(results.map((r) => r.id)).toEqual(["ctx_1"]);
			// …and the underlying requests were genuinely cancelled — the
			// signal handed to the Databricks query fired, so no orphaned
			// in-flight HTTP requests accumulate server-side.
			expect(capturedSignal?.aborted).toBe(true);
		} finally {
			vi.useRealTimers();
		}
	});

	it("aborts an in-flight branch when EMBEDDING generation fails and the function exits early", async () => {
		// The branch starts in parallel with embedding generation. When
		// embeddings come back empty the function returns early — the branch
		// must be torn down, not left running server-side for up to the full
		// 15s budget after the caller already got its answer.
		generateEmbeddingsMock.mockResolvedValue({ embeddings: [] });
		let capturedSignal: AbortSignal | undefined;
		queryDbxMock.mockImplementation(
			(_creds: unknown, args: { signal?: AbortSignal }) => {
				capturedSignal = args.signal;
				return new Promise(() => {}); // hang — abort is the only exit
			},
		);

		await expect(retrieveRelevantContextsForSpec(BASE)).resolves.toEqual(
			[],
		);

		// The branch may not have reached the query call yet at return time
		// (binding/credential loads are microtasks) — wait for it, then the
		// signal it received must already be aborted.
		await vi.waitFor(() => {
			expect(capturedSignal?.aborted).toBe(true);
		});
	});

	it("aborts an in-flight branch when the embedding failure is thrown (throwOnRetrievalError)", async () => {
		generateEmbeddingsMock.mockResolvedValue({ embeddings: [] });
		let capturedSignal: AbortSignal | undefined;
		queryDbxMock.mockImplementation(
			(_creds: unknown, args: { signal?: AbortSignal }) => {
				capturedSignal = args.signal;
				return new Promise(() => {});
			},
		);

		await expect(
			retrieveRelevantContextsForSpec({
				...BASE,
				throwOnRetrievalError: true,
			}),
		).rejects.toBeInstanceOf(RetrievalUnavailableError);

		await vi.waitFor(() => {
			expect(capturedSignal?.aborted).toBe(true);
		});
	});

	it("a partial failure (some sub-queries succeed) is not an outage", async () => {
		searchMock.mockResolvedValue([qdrantHit("ctx_1")]);
		queryDbxMock
			.mockRejectedValueOnce(new Error("transient"))
			.mockResolvedValue({
				chunks: [dbxChunk("cat.schema.idx_a", "1", 0.9)],
				failures: [],
				skippedIndexes: [],
			});

		const results = await retrieveRelevantContextsForSpec({
			...BASE,
			throwOnRetrievalError: true,
		});

		expect(
			results.some((r) => r.id === "databricks:int_1:cat.schema.idx_a:1"),
		).toBe(true);
	});
});
