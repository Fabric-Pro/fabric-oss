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
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../../embedding", () => ({ generateEmbedding: vi.fn() }));

vi.mock("../../embedding/sparse", () => ({
	generateSparseVector: vi.fn(() => ({ indices: [1], values: [1] })),
}));

vi.mock("../../reranking", () => ({ rerankContexts: vi.fn() }));

vi.mock("../store", () => ({ searchSimilarProjectContexts: vi.fn() }));

import {
	getProjectRagSettings,
	getRetrievableContextById,
} from "@repo/database";
import { generateEmbedding } from "../../embedding";
import { rerankContexts } from "../../reranking";
import { retrieveProjectContexts } from "../retrieval";
import { searchSimilarProjectContexts } from "../store";

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
		expect(res).toEqual(reranked);
	});
});
