import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ confidential: vi.fn() }));

vi.mock("@repo/database", () => ({
	db: {
		project: {
			findUnique: vi.fn().mockResolvedValue({ organizationId: "org1" }),
		},
	},
	findConfidentialTranscriptContextIds: h.confidential,
	getProjectRagSettings: vi.fn(),
	getRetrievableContextById: vi.fn(),
}));

vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("../../embedding", () => ({ generateQueryEmbedding: vi.fn() }));

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
import { generateQueryEmbedding } from "../../embedding";
import { retrieveProjectContexts } from "../retrieval";
import { searchSimilarProjectContexts } from "../store";

const hit = (contextId: string, score: number) => ({
	contextId,
	projectId: "p1",
	score,
	type: "TEXT",
});

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(getProjectRagSettings).mockResolvedValue({
		topK: 10,
		similarityThreshold: 0.3,
		enableReranking: false,
		rerankTopK: 10,
	} as never);
	vi.mocked(generateQueryEmbedding).mockResolvedValue({
		embedding: [0.1, 0.2, 0.3],
	} as never);
	vi.mocked(searchSimilarProjectContexts).mockResolvedValue([
		hit("ctx-secret-transcript", 0.9),
		hit("ctx-prd", 0.8),
		hit("ctx-open-transcript", 0.7),
	]);
	vi.mocked(getRetrievableContextById).mockImplementation((id: string) =>
		Promise.resolve({
			id,
			type: "TEXT",
			content: `content-of-${id}`,
			metadata: null,
		} as never),
	);
	h.confidential.mockResolvedValue(new Set(["ctx-secret-transcript"]));
});

describe("retrieveProjectContexts — confidential meeting series", () => {
	it("never reads or returns a confidential series' transcript", async () => {
		const result = await retrieveProjectContexts({
			projectId: "p1",
			query: "what did we decide about the export?",
			userId: "u1",
			organizationId: "org1",
		});

		expect(h.confidential).toHaveBeenCalledWith({
			projectId: "p1",
			contextIds: [
				"ctx-secret-transcript",
				"ctx-prd",
				"ctx-open-transcript",
			],
		});
		expect(result.map((context) => context.id)).toEqual([
			"ctx-prd",
			"ctx-open-transcript",
		]);
		expect(getRetrievableContextById).not.toHaveBeenCalledWith(
			"ctx-secret-transcript",
		);
	});
});
