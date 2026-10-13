/**
 * Code-index points (CODE_FILE / CODE_FILE_SUMMARY) have no ProjectContext row,
 * so context retrieval drops every one it gets. On an indexed repository they
 * are nearly all of a project's points and used to fill every topK slot,
 * leaving document generation with no context at all. The search must never
 * return them, on either the dense or the hybrid path.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { searchMock, queryMock, ensureCollectionMock, getLayoutMock } =
	vi.hoisted(() => ({
		searchMock: vi.fn(),
		queryMock: vi.fn(),
		ensureCollectionMock: vi.fn(),
		getLayoutMock: vi.fn(),
	}));

vi.mock("../client", () => ({
	qdrantClient: { search: searchMock, query: queryMock },
}));

vi.mock("../../collection-manager", () => ({
	ensureCollection: ensureCollectionMock,
	getCollectionLayout: getLayoutMock,
}));

import { searchSimilarProjectContexts } from "../store";

const BASE = {
	projectId: "proj_1",
	userId: "user_1",
	organizationId: "org_1",
	queryEmbedding: [0.1, 0.2, 0.3],
};

const EXCLUDES_CODE = {
	key: "contextType",
	match: { any: ["CODE_FILE", "CODE_FILE_SUMMARY"] },
};

beforeEach(() => {
	vi.clearAllMocks();
	ensureCollectionMock.mockResolvedValue(undefined);
	searchMock.mockResolvedValue([]);
	queryMock.mockResolvedValue({ points: [] });
});

describe("searchSimilarProjectContexts excludes code-index points", () => {
	it("on the dense path", async () => {
		getLayoutMock.mockResolvedValue({
			supportsHybrid: false,
			denseVectorName: null,
		});

		await searchSimilarProjectContexts({ ...BASE });

		const filter = searchMock.mock.calls[0]?.[1]?.filter;
		expect(filter.must_not).toContainEqual(EXCLUDES_CODE);
		expect(filter.must).toContainEqual({
			key: "projectId",
			match: { value: "proj_1" },
		});
	});

	it("on both prefetches of the hybrid path", async () => {
		getLayoutMock.mockResolvedValue({
			supportsHybrid: true,
			denseVectorName: "dense",
			sparseVectorName: "sparse",
		});

		await searchSimilarProjectContexts({
			...BASE,
			querySparseVector: { indices: [1], values: [1] },
		});

		const prefetch = queryMock.mock.calls[0]?.[1]?.prefetch ?? [];
		expect(prefetch).toHaveLength(2);
		for (const branch of prefetch) {
			expect(branch.filter.must_not).toContainEqual(EXCLUDES_CODE);
		}
	});
});
