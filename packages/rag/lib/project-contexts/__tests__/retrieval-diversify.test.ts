import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock every dependency of retrieveProjectContexts so we exercise only its
// candidate-pool / dedup / cap logic. Relative mock paths are resolved to the
// same modules retrieval.ts imports (Vitest matches by resolved module id).
vi.mock("@repo/database", () => ({
	db: {
		project: {
			findUnique: vi.fn().mockResolvedValue({ organizationId: "org1" }),
		},
	},
	getProjectRagSettings: vi.fn(),
	getRetrievableContextById: vi.fn(),
}));

vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("../../embedding", () => ({ generateEmbedding: vi.fn() }));

vi.mock("../../embedding/sparse", () => ({
	generateSparseVector: vi.fn(() => ({ indices: [1], values: [1] })),
}));

vi.mock("../../reranking", () => ({ rerankContexts: vi.fn() }));

vi.mock("../summary-injection", () => ({
	applyContextSummary: vi.fn(async (contexts) => contexts),
}));

vi.mock("../store", () => ({ searchSimilarProjectContexts: vi.fn() }));

import {
	getProjectRagSettings,
	getRetrievableContextById,
} from "@repo/database";
import { generateEmbedding } from "../../embedding";
import { rerankContexts } from "../../reranking";
import { retrieveProjectContexts } from "../retrieval";
import { searchSimilarProjectContexts } from "../store";
import { applyContextSummary } from "../summary-injection";

// A realistic candidate ranking: a long transcript's chunks dominate the top of
// the hybrid-RRF ranking; a PRD and a notes doc rank below all of them.
const CANDIDATES = [
	...Array.from({ length: 20 }, (_, i) => ({
		contextId: "ctx-transcript",
		projectId: "p1",
		score: 0.9 - i * 0.01,
		type: "TEXT",
	})),
	{ contextId: "ctx-prd", projectId: "p1", score: 0.55, type: "FILE" },
	{ contextId: "ctx-notes", projectId: "p1", score: 0.5, type: "TEXT" },
];

const baseOptions = {
	projectId: "p1",
	query: "create estimates for the features in section 7",
	userId: "u1",
	organizationId: "org1",
};

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(applyContextSummary).mockImplementation(
		async (contexts) => contexts,
	);
	vi.mocked(getProjectRagSettings).mockResolvedValue({
		topK: 50,
		similarityThreshold: 0.3,
		enableReranking: false,
		rerankTopK: 10,
	} as never);
	vi.mocked(generateEmbedding).mockResolvedValue({
		embedding: [0.1, 0.2, 0.3],
	} as never);
	// The store returns up to `topK` chunks from the ranked candidate list.
	vi.mocked(searchSimilarProjectContexts).mockImplementation((opts) =>
		Promise.resolve(CANDIDATES.slice(0, opts.topK)),
	);
	vi.mocked(getRetrievableContextById).mockImplementation((id: string) =>
		Promise.resolve({
			id,
			type: id === "ctx-prd" ? "FILE" : "TEXT",
			content: `content-of-${id}`,
			metadata: null,
			originalFilename: id === "ctx-prd" ? "prd.md" : null,
			sourceUrl: null,
			sourceTitle: null,
		} as never),
	);
});

describe("retrieveProjectContexts — diversify", () => {
	it("default (no diversify) collapses a chunk-monopolised search to the single dominant document", async () => {
		const res = await retrieveProjectContexts({ ...baseOptions, topK: 5 });

		// Asks the store for exactly topK chunks — no over-fetch.
		expect(searchSimilarProjectContexts).toHaveBeenCalledWith(
			expect.objectContaining({ topK: 5 }),
		);
		// The top 5 chunks are all the transcript → dedup-by-contextId collapses
		// to it alone. This is the reproduced bug the diversify path fixes.
		expect(res.map((c) => c.id)).toEqual(["ctx-transcript"]);
	});

	it("diversify surfaces other documents the dominant document was hiding", async () => {
		const res = await retrieveProjectContexts({
			...baseOptions,
			topK: 5,
			diversify: true,
		});

		// Over-fetches a generous candidate pool so other documents' chunks appear.
		expect(searchSimilarProjectContexts).toHaveBeenCalledWith(
			expect.objectContaining({ topK: 120 }),
		);
		const ids = res.map((c) => c.id);
		expect(ids).toContain("ctx-transcript");
		expect(ids).toContain("ctx-prd"); // the PRD now appears
		expect(ids).toContain("ctx-notes");
		// Relevance order preserved (transcript still ranks first).
		expect(ids[0]).toBe("ctx-transcript");
	});

	it("respects the maxContexts cap when diversifying", async () => {
		const res = await retrieveProjectContexts({
			...baseOptions,
			topK: 5,
			diversify: true,
			maxContexts: 2,
		});

		expect(res).toHaveLength(2);
		expect(res.map((c) => c.id)).toEqual(["ctx-transcript", "ctx-prd"]);
	});

	// The skip used to be implicit in the diversify branch. It is now an
	// explicit caller opt-out (`skipRerank`), because diversity and relevance
	// ordering are independent and a background caller wants both — so the
	// latency exemption has to be asked for rather than inherited.
	it("skips reranking on the diversify path when the caller opts out (keeps the agent path fast)", async () => {
		await retrieveProjectContexts({
			...baseOptions,
			topK: 5,
			diversify: true,
			skipRerank: true,
		});
		expect(rerankContexts).not.toHaveBeenCalled();
	});

	it("reranks the diversified set when the caller does NOT opt out", async () => {
		vi.mocked(getProjectRagSettings).mockResolvedValue({
			topK: 50,
			similarityThreshold: 0.3,
			enableReranking: true,
			rerankTopK: 10,
		} as never);
		const reranked = [
			{
				id: "ctx-prd",
				type: "FILE",
				content: "content-of-ctx-prd",
				score: 0.95,
			},
		];
		vi.mocked(rerankContexts).mockResolvedValue({
			contexts: reranked,
			stats: {
				inputCount: 2,
				outputCount: 1,
				latencyMs: 1,
				provider: "cross-encoder",
			},
		} as never);

		const res = await retrieveProjectContexts({
			...baseOptions,
			topK: 5,
			diversify: true,
		});

		// Diversification still ran first: the reranker was handed the deduped
		// distinct documents, not the raw chunk-monopolised candidate pool.
		expect(rerankContexts).toHaveBeenCalledTimes(1);
		expect(rerankContexts).toHaveBeenCalledWith(
			expect.objectContaining({
				tenant: {
					userId: baseOptions.userId,
					organizationId: baseOptions.organizationId,
					projectId: baseOptions.projectId,
				},
			}),
		);
		const handed = vi.mocked(rerankContexts).mock.calls[0][0] as {
			contexts: Array<{ id: string }>;
		};
		expect(handed.contexts.map((c) => c.id)).toEqual([
			"ctx-transcript",
			"ctx-prd",
			"ctx-notes",
		]);
		expect(res.map((c) => c.id)).toEqual(["ctx-prd"]);
	});

	it("passes the project's resolved organization when the caller omits it", async () => {
		vi.mocked(getProjectRagSettings).mockResolvedValue({
			topK: 50,
			similarityThreshold: 0.3,
			enableReranking: true,
		} as never);
		vi.mocked(rerankContexts).mockResolvedValue({
			contexts: [],
			stats: {
				inputCount: 3,
				outputCount: 0,
				latencyMs: 1,
				provider: "gateway",
			},
		});
		await retrieveProjectContexts({
			...baseOptions,
			organizationId: undefined,
			diversify: true,
		});
		expect(rerankContexts).toHaveBeenCalledWith(
			expect.objectContaining({
				tenant: {
					userId: "u1",
					organizationId: "org1",
					projectId: "p1",
				},
			}),
		);
	});

	it("keeps the diversified results when reranking fails", async () => {
		vi.mocked(getProjectRagSettings).mockResolvedValue({
			topK: 50,
			similarityThreshold: 0.3,
			enableReranking: true,
			rerankTopK: 10,
		} as never);
		vi.mocked(rerankContexts).mockRejectedValue(
			new Error("reranker unavailable"),
		);

		const res = await retrieveProjectContexts({
			...baseOptions,
			topK: 5,
			diversify: true,
		});

		expect(res.map((c) => c.id)).toEqual([
			"ctx-transcript",
			"ctx-prd",
			"ctx-notes",
		]);
	});

	it("regression: the default (non-diversify) path still reranks when the project enables it", async () => {
		// Guards the "every other caller is unchanged" guarantee: the opt-in
		// diversify early-return must not bypass reranking for the default path.
		vi.mocked(getProjectRagSettings).mockResolvedValue({
			topK: 50,
			similarityThreshold: 0.3,
			enableReranking: true,
			rerankTopK: 10,
		} as never);
		const reranked = [
			{
				id: "ctx-prd",
				type: "FILE",
				content: "content-of-ctx-prd",
				score: 0.9,
			},
		];
		vi.mocked(rerankContexts).mockResolvedValue({
			contexts: reranked,
			stats: {
				inputCount: 3,
				outputCount: 1,
				latencyMs: 5,
				provider: "cross-encoder",
			},
		} as never);

		const res = await retrieveProjectContexts({ ...baseOptions, topK: 50 });

		// No over-fetch on the default path …
		expect(searchSimilarProjectContexts).toHaveBeenCalledWith(
			expect.objectContaining({ topK: 50 }),
		);
		// … and reranking still runs (3 distinct contexts > 1).
		expect(rerankContexts).toHaveBeenCalledTimes(1);
		expect(res).toEqual([
			expect.objectContaining({ ...reranked[0], filename: "prd.md" }),
		]);
	});
});

it("retains matched passages in relevance order only when requested", async () => {
	vi.mocked(searchSimilarProjectContexts).mockResolvedValue([
		{
			contextId: "ctx-prd",
			projectId: "p1",
			score: 0.9,
			type: "FILE",
			content: "Best passage",
		},
		{ contextId: "ctx-notes", projectId: "p1", score: 0.8, type: "TEXT" },
		{
			contextId: "ctx-prd",
			projectId: "p1",
			score: 0.7,
			type: "FILE",
			content: "Further passage",
		},
	]);
	const options = {
		...baseOptions,
		diversify: true,
		includeMatchedPassages: true,
	};
	const result = await retrieveProjectContexts(options);
	expect(result[0]).toMatchObject({
		content: "content-of-ctx-prd",
		matchedPassages: [
			{ content: "Best passage", score: 0.9 },
			{ content: "Further passage", score: 0.7 },
		],
	});
	expect(result[1]).toHaveProperty("matchedPassages", []);
	const legacy = await retrieveProjectContexts(baseOptions);
	expect(legacy[0]).not.toHaveProperty("matchedPassages");
});

it.each(["skipped", "fallback-passthrough", "disabled"])(
	"caps default retrieval for %s and excludes document chunks",
	async (model) => {
		vi.mocked(getProjectRagSettings).mockResolvedValue({
			topK: 50,
			rerankTopK: 1,
			enableReranking: model !== "disabled",
		} as never);
		vi.mocked(rerankContexts).mockImplementation(
			async (input) =>
				({ contexts: input.contexts, stats: { model } }) as never,
		);
		const result = await retrieveProjectContexts(baseOptions);
		expect(result.map((c) => c.id)).toEqual(["ctx-transcript"]);
		expect(searchSimilarProjectContexts).toHaveBeenCalledWith(
			expect.objectContaining({ excludeDocumentChunks: true }),
		);
	},
);
it("ranks a diversified candidate beyond the source cap", async () => {
	vi.mocked(getProjectRagSettings).mockResolvedValue({
		topK: 50,
		rerankTopK: 10,
		enableReranking: true,
	} as never);
	vi.mocked(rerankContexts).mockImplementation(
		async (input) =>
			({
				contexts: input.contexts.map((c) => ({
					...c,
					score: c.id === "ctx-notes" ? 1 : 0,
				})),
				stats: { model: "test" },
			}) as never,
	);
	expect(
		(
			await retrieveProjectContexts({
				...baseOptions,
				diversify: true,
				maxContexts: 1,
			})
		).map((c) => c.id),
	).toEqual(["ctx-notes"]);
	expect(
		(
			await retrieveProjectContexts({
				...baseOptions,
				diversify: true,
				maxContexts: 2,
				skipRerank: true,
			})
		).map((c) => c.id),
	).toEqual(["ctx-transcript", "ctx-prd"]);
});

it.each([1, 2])("keeps the summary plus %i selected sources", async (limit) => {
	vi.mocked(getProjectRagSettings).mockResolvedValue({
		topK: 50,
		rerankTopK: limit,
		enableReranking: false,
	} as never);
	const summary = {
		id: "example-summary",
		type: "PROJECT_SUMMARY",
		content: "summary content",
		score: 1,
		sourceTitle: "Compressed project history (summary)",
		metadata: {
			isSummary: true,
			summaryId: "example-summary",
			engineVersion: 1,
			coveredThrough: "2026-01-01T00:00:00.000Z",
			coveredContextCount: 0,
			references: [],
		},
	};
	vi.mocked(applyContextSummary).mockImplementation(async (contexts) => [
		summary,
		...contexts,
	]);
	const result = await retrieveProjectContexts(baseOptions);
	expect(result[0]).toEqual(summary);
	expect(result.map((c) => c.id)).toEqual([
		"example-summary",
		...["ctx-transcript", "ctx-prd"].slice(0, limit),
	]);
	expect(result).toHaveLength(limit + 1);
});
