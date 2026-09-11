/**
 * The unseen-context quota in `retrieveRelevantContextsForSpec`.
 *
 * Fusion ranks by similarity and holds no opinion about age, which quietly
 * breaks a repeating "update this document" cycle: the document is written FROM
 * its early sources, so it resembles them more closely than it resembles
 * anything said since, and those same sources win the ranking on every later
 * run. The model is handed only material already in the document, answers
 * "nothing has changed" — correctly — and the document never moves again.
 *
 * These tests pin the quota as a FLOOR: it decides which candidates survive the
 * cut, never their order, never their number, and never runs at all unless a
 * caller asks for it.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const {
	getProviderConfigMock,
	generateEmbeddingsMock,
	searchMock,
	chunkTextMock,
	applySummaryMock,
	getContextMock,
	databricksEnabledMock,
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
	databricksEnabledMock: vi.fn(() => false),
	loadBindingMock: vi.fn(),
	fetchCredsMock: vi.fn(),
	queryDbxMock: vi.fn(),
}));

vi.mock("@repo/ai", () => ({ getRAGProviderConfig: getProviderConfigMock }));
vi.mock("@repo/database", () => ({
	getRetrievableContextById: getContextMock,
	loadProjectDatabricksKnowledgeBinding: loadBindingMock,
	fetchCredentialsByIdInTenant: fetchCredsMock,
}));
vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@repo/utils/feature-flag", () => ({
	isProjectDatabricksKnowledgeEnabled: databricksEnabledMock,
}));
// Dynamic import target — vi.mock covers `await import(...)` too.
vi.mock("@repo/integrations/databricks-vector-search", () => ({
	MAX_QUERY_INDEXES: 16,
	queryDatabricksVectorIndexes: queryDbxMock,
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

import { retrieveRelevantContextsForSpec } from "../retrieve-for-spec";

/** Everything is comfortably newer than this, so the hard filter never fires. */
const BASELINE = new Date("2026-01-01T00:00:00Z");
/** The document's last content change — the line between seen and unseen. */
const LAST_WRITE = new Date("2026-09-02T00:00:00Z");

const OLD = new Date("2026-08-01T00:00:00Z");
const NEW = new Date("2026-09-09T00:00:00Z");

const BASE = {
	projectId: "proj_1",
	userId: "user_1",
	organizationId: "org_1",
	specMarkdown: "# PRD\n\nThe rollout plan.",
	baselineDate: BASELINE,
	// Small enough that "which three survived" is unambiguous.
	topK: 3,
};

/**
 * Rank order is the order these come back in: one query chunk means RRF ranks
 * by position, so `ctx_1` is the strongest similarity match and `ctx_6` the
 * weakest.
 */
const RANKED = ["ctx_1", "ctx_2", "ctx_3", "ctx_4", "ctx_5", "ctx_6"];

/** `ctx_5` and `ctx_6` arrived after the document was last written. */
const createdAtById: Record<string, Date> = {
	ctx_1: OLD,
	ctx_2: OLD,
	ctx_3: OLD,
	ctx_4: OLD,
	ctx_5: NEW,
	ctx_6: NEW,
};

beforeEach(() => {
	vi.clearAllMocks();
	getProviderConfigMock.mockResolvedValue({ provider: "openai" });
	chunkTextMock.mockReturnValue([{ content: "chunk 0" }]);
	generateEmbeddingsMock.mockImplementation(async (texts: string[]) => ({
		embeddings: texts.map(() => [0.1, 0.2, 0.3]),
	}));
	searchMock.mockResolvedValue(
		RANKED.map((contextId) => ({
			contextId,
			score: 0.8,
			content: `chunk for ${contextId}`,
		})),
	);
	getContextMock.mockImplementation(async (id: string) => ({
		id,
		type: "MEETING_TRANSCRIPT",
		content: `transcript ${id}`,
		createdAt: createdAtById[id],
		metadata: null,
		originalFilename: null,
		sourceUrl: null,
		sourceTitle: `Meeting ${id}`,
	}));
	applySummaryMock.mockImplementation(async (list: unknown[]) => list);
	databricksEnabledMock.mockReturnValue(false);
	loadBindingMock.mockResolvedValue({
		integrationId: "int_1",
		schema: "cat.schema",
		indexNames: ["cat.schema.idx_a"],
	});
	fetchCredsMock.mockResolvedValue({
		DATABRICKS_HOST: "https://example.test",
	});
	queryDbxMock.mockResolvedValue({
		chunks: [],
		failures: [],
		skippedIndexes: [],
	});
});

const ids = (results: Array<{ id: string }>) => results.map((r) => r.id);

describe("without the quota", () => {
	it("takes the top topK by rank, exactly as before", async () => {
		// The untouched path every other caller is on — v1 knowledge search, the
		// story path. The newest material losing the cut here is the bug, not a
		// regression: this is what shipped.
		const results = await retrieveRelevantContextsForSpec(BASE);

		expect(ids(results)).toEqual(["ctx_1", "ctx_2", "ctx_3"]);
	});
});

describe("with the quota", () => {
	it("promotes unseen context past the cut it would otherwise lose", async () => {
		const results = await retrieveRelevantContextsForSpec({
			...BASE,
			unseenQuota: { since: LAST_WRITE, slots: 1 },
		});

		// ctx_5 ranked fifth and could never have been seen; it takes the slot
		// ctx_3 would have had.
		expect(ids(results)).toEqual(["ctx_1", "ctx_2", "ctx_5"]);
	});

	it("keeps results in rank order — the quota picks, it does not sort", async () => {
		const results = await retrieveRelevantContextsForSpec({
			...BASE,
			unseenQuota: { since: LAST_WRITE, slots: 2 },
		});

		// Promoted, but still behind the stronger match rather than ahead of it:
		// the prompt ranks its sources, and recency must not rewrite that.
		expect(ids(results)).toEqual(["ctx_1", "ctx_5", "ctx_6"]);
	});

	it("never returns more than topK", async () => {
		const results = await retrieveRelevantContextsForSpec({
			...BASE,
			unseenQuota: { since: LAST_WRITE, slots: 99 },
		});

		expect(results).toHaveLength(3);
	});

	it("hands unused slots back to the ranking rather than padding", async () => {
		// Only one unseen context exists but three slots were reserved. A quota
		// that treated its reservation as a target would have to pad the prompt
		// with weaker matches; this one gives the surplus back.
		getContextMock.mockImplementation(async (id: string) => ({
			id,
			type: "MEETING_TRANSCRIPT",
			content: `transcript ${id}`,
			createdAt: id === "ctx_6" ? NEW : OLD,
			metadata: null,
			originalFilename: null,
			sourceUrl: null,
			sourceTitle: `Meeting ${id}`,
		}));

		const results = await retrieveRelevantContextsForSpec({
			...BASE,
			unseenQuota: { since: LAST_WRITE, slots: 3 },
		});

		expect(ids(results)).toEqual(["ctx_1", "ctx_2", "ctx_6"]);
	});

	it("reaches unseen context ranked below the pre-hydration cut", async () => {
		// The cut that nearly defeated this: candidates are truncated to topK * 3
		// BEFORE the rows are hydrated, and "unseen" is only knowable AFTER —
		// createdAt lives on the row, not in the fused score. On exactly the
		// workload the quota exists for, the old similar sources fill the ranking
		// and the reserved population is what the truncation throws away, so the
		// quota would hold slots open for candidates it could no longer see.
		//
		// topK is 3 here, so the old cut was 9. The only unseen context is ranked
		// twelfth — outside it.
		const ranked = Array.from({ length: 12 }, (_, i) => `ctx_${i + 1}`);
		searchMock.mockResolvedValue(
			ranked.map((contextId) => ({
				contextId,
				score: 0.8,
				content: `chunk for ${contextId}`,
			})),
		);
		getContextMock.mockImplementation(async (id: string) => ({
			id,
			type: "MEETING_TRANSCRIPT",
			content: `transcript ${id}`,
			createdAt: id === "ctx_12" ? NEW : OLD,
			metadata: null,
			originalFilename: null,
			sourceUrl: null,
			sourceTitle: `Meeting ${id}`,
		}));

		const results = await retrieveRelevantContextsForSpec({
			...BASE,
			unseenQuota: { since: LAST_WRITE, slots: 1 },
		});

		expect(ids(results)).toEqual(["ctx_1", "ctx_2", "ctx_12"]);
	});

	it("leaves the pre-hydration cut alone for callers without the quota", async () => {
		// The widened pool is the opt-in caller's cost, not everyone's: without a
		// quota the ranked list is still truncated to topK * 3 before hydration,
		// so rows past it are never even read.
		const ranked = Array.from({ length: 12 }, (_, i) => `ctx_${i + 1}`);
		searchMock.mockResolvedValue(
			ranked.map((contextId) => ({
				contextId,
				score: 0.8,
				content: `chunk for ${contextId}`,
			})),
		);
		getContextMock.mockImplementation(async (id: string) => ({
			id,
			type: "MEETING_TRANSCRIPT",
			content: `transcript ${id}`,
			createdAt: OLD,
			metadata: null,
			originalFilename: null,
			sourceUrl: null,
			sourceTitle: `Meeting ${id}`,
		}));

		await retrieveRelevantContextsForSpec(BASE);

		const hydrated = getContextMock.mock.calls.map((c) => c[0]);
		expect(hydrated).toHaveLength(9);
		expect(hydrated).not.toContain("ctx_12");
	});

	it("changes nothing when every candidate is already reflected", async () => {
		const results = await retrieveRelevantContextsForSpec({
			...BASE,
			// Nothing is newer than this, so no candidate qualifies.
			unseenQuota: { since: new Date("2027-01-01T00:00:00Z"), slots: 2 },
		});

		expect(ids(results)).toEqual(["ctx_1", "ctx_2", "ctx_3"]);
	});
});

describe("with the quota and an external knowledge index", () => {
	it("does not let external hits evict the contexts the quota just rescued", async () => {
		// The hole this closes. External hits carry no timestamp, so none of them
		// can ever satisfy the reservation — and a plain score sort hands them the
		// reserved slots first, because a promoted context is by definition one
		// that lost on score. Without the guard the quota is undone at the last
		// step, silently, and only for projects with an index bound.
		databricksEnabledMock.mockReturnValue(true);
		queryDbxMock.mockResolvedValue({
			chunks: [
				{
					indexName: "cat.schema.idx_a",
					id: "ext_1",
					score: 0.99,
					content: "external chunk",
				},
			],
			failures: [],
			skippedIndexes: [],
		});

		const results = await retrieveRelevantContextsForSpec({
			...BASE,
			unseenQuota: { since: LAST_WRITE, slots: 1 },
		});

		expect(results).toHaveLength(3);
		expect(ids(results)).toContain("ctx_5");
	});

	it("still lets external hits displace ordinary internal ones", async () => {
		// The guard protects the reservation, not the whole internal list: with no
		// quota asked for, the merge is exactly what it always was.
		databricksEnabledMock.mockReturnValue(true);
		queryDbxMock.mockResolvedValue({
			chunks: [
				{
					indexName: "cat.schema.idx_a",
					id: "ext_1",
					score: 0.99,
					content: "external chunk",
				},
			],
			failures: [],
			skippedIndexes: [],
		});

		const results = await retrieveRelevantContextsForSpec(BASE);

		expect(results).toHaveLength(3);
		expect(results.some((r) => r.type === "EXTERNAL_INDEX")).toBe(true);
	});
});
