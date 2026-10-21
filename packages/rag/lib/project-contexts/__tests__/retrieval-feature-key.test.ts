/**
 * `retrieveProjectContexts` serves several features, so its query embedding
 * used to reach AI Usage with no feature key whenever the caller named none.
 * It now defaults to `knowledge-search`, and a feature the caller named still
 * wins.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", () => ({
	db: {
		project: {
			findUnique: vi.fn().mockResolvedValue({ organizationId: "org-1" }),
		},
	},
	getProjectRagSettings: vi.fn(async () => ({
		topK: 5,
		similarityThreshold: 0.5,
		enableReranking: false,
	})),
	getRetrievableContextById: vi.fn(),
	getRetrievableConversationBundleById: vi.fn(),
}));

vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../../embedding", () => ({ generateEmbedding: vi.fn() }));

vi.mock("../../embedding/sparse", () => ({
	generateSparseVector: vi.fn(() => ({ indices: [1], values: [1] })),
}));

vi.mock("../store", () => ({ searchSimilarProjectContexts: vi.fn() }));

vi.mock("../summary-injection", () => ({
	applyContextSummary: (list: unknown) => list,
}));

import { generateEmbedding } from "../../embedding";
import { retrieveProjectContexts } from "../retrieval";
import { searchSimilarProjectContexts } from "../store";

const OPTIONS = {
	projectId: "project-1",
	query: "launch plan",
	userId: "user-1",
	organizationId: "org-1",
};

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(generateEmbedding).mockResolvedValue({
		embedding: [0.1],
		model: "example-model",
		tokens: 1,
	});
	vi.mocked(searchSimilarProjectContexts).mockResolvedValue([]);
});

describe("retrieveProjectContexts feature key", () => {
	it("tags the query embedding as knowledge search by default", async () => {
		await retrieveProjectContexts(OPTIONS);

		expect(vi.mocked(generateEmbedding).mock.calls[0][1]).toMatchObject({
			featureKey: "knowledge-search",
		});
	});

	it("keeps the feature its caller named", async () => {
		await retrieveProjectContexts({
			...OPTIONS,
			usageOrigin: { featureKey: "chat-agent" },
		});

		expect(vi.mocked(generateEmbedding).mock.calls[0][1]).toMatchObject({
			featureKey: "chat-agent",
		});
	});
});
