/**
 * Company context search (Fizzy #2719).
 *
 * The filter is the whole contract: every query stays inside one
 * organization's collection, inside the model the query was embedded with,
 * and inside the sources the caller found ready. A read must also never
 * create the collection it looks for, and asks Qdrant about that one
 * collection rather than listing every collection in the instance.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const {
	searchMock,
	getCollectionMock,
	getCollectionsMock,
	existsUncachedMock,
	getLayoutMock,
} = vi.hoisted(() => ({
	searchMock: vi.fn(),
	getCollectionMock: vi.fn(),
	getCollectionsMock: vi.fn(),
	existsUncachedMock: vi.fn(),
	getLayoutMock: vi.fn(),
}));

vi.mock("../../vector-store/client", () => ({
	qdrantClient: {
		search: searchMock,
		getCollection: getCollectionMock,
		getCollections: getCollectionsMock,
	},
	DISTANCE_METRIC: "Cosine",
	VECTOR_SIZE: 1536,
}));

vi.mock("../../collection-manager", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../../collection-manager")>();
	return {
		// The real name resolver, so the org-only rule is the one under test.
		COMPANY_CONTEXTS_BASE_COLLECTION:
			actual.COMPANY_CONTEXTS_BASE_COLLECTION,
		getCollectionName: actual.getCollectionName,
		collectionExistsUncached: existsUncachedMock,
		getCollectionLayout: getLayoutMock,
	};
});

vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { searchCompanyContexts } from "../search";

const BASE = {
	organizationId: "org_example",
	embeddingModel: "openai:text-embedding-3-small",
	queryEmbedding: [0.1, 0.2, 0.3],
	sourceIds: ["src_a", "src_b"],
};

/** What the Qdrant client throws for a missing collection. */
function notFound(): Error {
	return Object.assign(new Error("Not Found"), { status: 404 });
}

beforeEach(() => {
	vi.clearAllMocks();
	getCollectionMock.mockResolvedValue({ status: "green" });
	getLayoutMock.mockResolvedValue({
		collectionName: "company-contexts-org-org_example",
		denseVectorName: "dense",
		sparseVectorName: "sparse",
		supportsHybrid: true,
	});
	searchMock.mockResolvedValue([]);
});

describe("searchCompanyContexts", () => {
	it("searches the organization's collection, filtered to its org, model and ready sources", async () => {
		await searchCompanyContexts({
			...BASE,
			topK: 8,
			minSimilarity: 0.62,
		});

		expect(getCollectionMock).toHaveBeenCalledWith(
			"company-contexts-org-org_example",
		);
		// One collection asked about, never the instance's whole list.
		expect(getCollectionsMock).not.toHaveBeenCalled();
		expect(existsUncachedMock).not.toHaveBeenCalled();
		expect(searchMock).toHaveBeenCalledTimes(1);
		const [collection, request] = searchMock.mock.calls[0];
		expect(collection).toBe("company-contexts-org-org_example");
		expect(request).toMatchObject({
			vector: { name: "dense", vector: BASE.queryEmbedding },
			limit: 8,
			score_threshold: 0.62,
		});
		expect(request.filter.must).toEqual([
			{ key: "organizationId", match: { value: "org_example" } },
			{
				key: "embeddingModel",
				match: { value: "openai:text-embedding-3-small" },
			},
			{ key: "originalContextId", match: { any: ["src_a", "src_b"] } },
		]);
	});

	it("maps hits to their source id, keeping page chunks under their source", async () => {
		searchMock.mockResolvedValue([
			{
				id: "p1",
				score: 0.91,
				payload: {
					organizationId: "org_example",
					originalContextId: "src_a",
					contextId: "page_1",
					parentContextId: "src_a",
					contextType: "LINK",
					content: "We delivered a warehouse rollout.",
					chunkIndex: 2,
					sourceUrl: "https://example.com/work",
					sourceTitle: "Our work",
				},
			},
			{
				id: "p2",
				score: 0.8,
				payload: {
					organizationId: "org_example",
					originalContextId: "src_b",
					contextType: "TEXT",
					content: "Certified delivery partner.",
				},
			},
		]);

		const hits = await searchCompanyContexts(BASE);

		expect(hits).toEqual([
			{
				sourceId: "src_a",
				contextId: "page_1",
				parentContextId: "src_a",
				contextType: "LINK",
				content: "We delivered a warehouse rollout.",
				chunkIndex: 2,
				score: 0.91,
				sourceUrl: "https://example.com/work",
				sourceTitle: "Our work",
			},
			{
				sourceId: "src_b",
				contextId: "src_b",
				parentContextId: null,
				contextType: "TEXT",
				content: "Certified delivery partner.",
				chunkIndex: null,
				score: 0.8,
				sourceUrl: null,
				sourceTitle: null,
			},
		]);
	});

	it("drops points with no source id or no text", async () => {
		searchMock.mockResolvedValue([
			{ id: "p1", score: 0.9, payload: { content: "orphan" } },
			{ id: "p2", score: 0.9, payload: { originalContextId: "src_a" } },
			{ id: "p3", score: 0.9, payload: null },
		]);

		expect(await searchCompanyContexts(BASE)).toEqual([]);
	});

	it("does not reach Qdrant with no ready sources", async () => {
		expect(await searchCompanyContexts({ ...BASE, sourceIds: [] })).toEqual(
			[],
		);
		expect(getCollectionMock).not.toHaveBeenCalled();
		expect(searchMock).not.toHaveBeenCalled();
	});

	it("returns nothing, and creates nothing, when the collection does not exist", async () => {
		getCollectionMock.mockRejectedValue(notFound());

		expect(await searchCompanyContexts(BASE)).toEqual([]);
		expect(getLayoutMock).not.toHaveBeenCalled();
		expect(searchMock).not.toHaveBeenCalled();
		expect(getCollectionsMock).not.toHaveBeenCalled();
	});

	it("lets a failed existence check propagate rather than read as no collection", async () => {
		getCollectionMock.mockRejectedValue(
			Object.assign(new Error("Service Unavailable"), { status: 503 }),
		);

		await expect(searchCompanyContexts(BASE)).rejects.toThrow(
			"Service Unavailable",
		);
		expect(searchMock).not.toHaveBeenCalled();
	});

	it("throws without an organization rather than searching a shared collection", async () => {
		await expect(
			searchCompanyContexts({ ...BASE, organizationId: "" }),
		).rejects.toThrow(/requires an organization/);
		expect(searchMock).not.toHaveBeenCalled();
	});

	it("throws without an embedding model", async () => {
		await expect(
			searchCompanyContexts({ ...BASE, embeddingModel: "" }),
		).rejects.toThrow(/embedding model/);
		expect(searchMock).not.toHaveBeenCalled();
	});

	it("lets a Qdrant failure propagate", async () => {
		searchMock.mockRejectedValue(new Error("qdrant unavailable"));

		await expect(searchCompanyContexts(BASE)).rejects.toThrow(
			"qdrant unavailable",
		);
	});
});
