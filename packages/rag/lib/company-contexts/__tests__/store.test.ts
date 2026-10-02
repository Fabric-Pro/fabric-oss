/**
 * Company context points (Fizzy #2719): what the company store writes to
 * Qdrant, and how it deletes.
 *
 * The payload is the contract retrieval reads: the source as
 * `originalContextId` (also on a crawled page's chunks), the row the text
 * came from as `contextId`, the type and the embedding model — and never a
 * project. Deletes resolve the collection by name exactly as the writers do,
 * check it exists without creating it, and throw on a Qdrant failure so a
 * caller keeps the ids it would need to retry.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const {
	upsertMock,
	deleteMock,
	getCollectionLayoutMock,
	ensureCollectionMock,
	collectionExistsUncachedMock,
} = vi.hoisted(() => ({
	upsertMock: vi.fn(),
	deleteMock: vi.fn(),
	getCollectionLayoutMock: vi.fn(),
	ensureCollectionMock: vi.fn(),
	collectionExistsUncachedMock: vi.fn(),
}));

vi.mock("../../vector-store/client", () => ({
	qdrantClient: { upsert: upsertMock, delete: deleteMock },
	VECTOR_SIZE: 1536,
	DISTANCE_METRIC: "Cosine",
}));

vi.mock("../../collection-manager", async () => {
	// The real name resolver: the store must aim where the writers aim.
	const { getCollectionName, COMPANY_CONTEXTS_BASE_COLLECTION } =
		await vi.importActual<typeof import("../../collection-manager")>(
			"../../collection-manager",
		);
	return {
		COMPANY_CONTEXTS_BASE_COLLECTION,
		getCollectionName,
		getCollectionLayout: getCollectionLayoutMock,
		ensureCollection: ensureCollectionMock,
		collectionExistsUncached: collectionExistsUncachedMock,
	};
});

vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
	type CompanyContextPointInput,
	companyContextPointId,
	deleteCompanyContextRowPoints,
	deleteCompanyContextSourcePoints,
	deleteCompanyPagePointsNotIn,
	storeCompanyContextPoints,
} from "../store";

/** Write one point through the batched store; its id. */
async function storeCompanyContextPoint(
	input: CompanyContextPointInput,
): Promise<string> {
	const [id] = await storeCompanyContextPoints([input]);
	return id;
}

const ORG = "org1";
const COLLECTION = `company-contexts-org-${ORG}`;

function point(
	overrides: Partial<CompanyContextPointInput> = {},
): CompanyContextPointInput {
	return {
		organizationId: ORG,
		sourceId: "src-1",
		contextId: "src-1",
		contextType: "FILE",
		embeddingModel: "OPENAI_DIRECT:text-embedding-3-small",
		content: "Capabilities overview.",
		chunkIndex: 0,
		embedding: [0.1, 0.2, 0.3],
		sparseVector: { indices: [1], values: [1] },
		...overrides,
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	getCollectionLayoutMock.mockResolvedValue({
		collectionName: COLLECTION,
		denseVectorName: "dense",
		sparseVectorName: "sparse",
		supportsHybrid: true,
	});
	upsertMock.mockResolvedValue({ status: "completed" });
	deleteMock.mockResolvedValue({ status: "completed" });
	collectionExistsUncachedMock.mockResolvedValue(true);
});

describe("storeCompanyContextPoints", () => {
	it("writes the company payload to the organization's company collection, never a project", async () => {
		const ids = await storeCompanyContextPoints([
			point(),
			point({ content: "Delivery model.", chunkIndex: 1 }),
		]);

		expect(getCollectionLayoutMock).toHaveBeenCalledWith(
			"company-contexts",
			ORG,
		);
		expect(upsertMock).toHaveBeenCalledTimes(1);
		const [collection, body] = upsertMock.mock.calls[0];
		expect(collection).toBe(COLLECTION);
		expect(body.wait).toBe(true);
		expect(body.points).toHaveLength(2);
		const [first, second] = body.points;
		expect(first.payload).toEqual({
			organizationId: ORG,
			originalContextId: "src-1",
			contextId: "src-1",
			parentContextId: null,
			contextType: "FILE",
			embeddingModel: "OPENAI_DIRECT:text-embedding-3-small",
			content: "Capabilities overview.",
			chunkIndex: 0,
			sourceUrl: null,
			sourceTitle: null,
			createdAt: expect.any(String),
		});
		expect(first.payload).not.toHaveProperty("projectId");
		expect(second.payload).toMatchObject({
			chunkIndex: 1,
			content: "Delivery model.",
		});
		expect(first.vector).toEqual({
			dense: [0.1, 0.2, 0.3],
			sparse: { indices: [1], values: [1] },
		});
		expect(ids).toEqual([first.id, second.id]);
	});

	it("keeps the source as originalContextId on a crawled page's chunks", async () => {
		await storeCompanyContextPoint(
			point({
				contextId: "page-7",
				parentContextId: "src-1",
				contextType: "LINK",
				sourceUrl: "https://example.com/services",
				sourceTitle: "Services",
			}),
		);

		expect(upsertMock.mock.calls[0][1].points[0].payload).toMatchObject({
			originalContextId: "src-1",
			contextId: "page-7",
			parentContextId: "src-1",
			contextType: "LINK",
			sourceUrl: "https://example.com/services",
			sourceTitle: "Services",
		});
	});

	it("derives point ids from the row and chunk, so a retry replaces rather than duplicates", async () => {
		const first = await storeCompanyContextPoint(point());
		const again = await storeCompanyContextPoint(point());
		const nextChunk = await storeCompanyContextPoint(
			point({ chunkIndex: 1 }),
		);
		const otherRow = await storeCompanyContextPoint(
			point({ contextId: "page-7" }),
		);

		expect(again).toBe(first);
		expect(first).toBe(companyContextPointId("src-1", 0));
		expect(new Set([first, nextChunk, otherRow]).size).toBe(3);
		expect(first).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
		);
	});

	it("writes an unnamed dense vector to a collection without hybrid support", async () => {
		getCollectionLayoutMock.mockResolvedValue({
			collectionName: COLLECTION,
			denseVectorName: null,
			sparseVectorName: null,
			supportsHybrid: false,
		});

		await storeCompanyContextPoint(point());

		expect(upsertMock.mock.calls[0][1].points[0].vector).toEqual([
			0.1, 0.2, 0.3,
		]);
	});

	it("splits a large source into several upserts", async () => {
		const points = Array.from({ length: 130 }, (_, chunkIndex) =>
			point({ chunkIndex }),
		);

		const ids = await storeCompanyContextPoints(points);

		expect(upsertMock).toHaveBeenCalledTimes(3);
		expect(
			upsertMock.mock.calls.map((call) => call[1].points.length),
		).toEqual([64, 64, 2]);
		expect(ids).toHaveLength(130);
	});

	it("refuses points of two organizations in one call, writing nothing", async () => {
		await expect(
			storeCompanyContextPoints([
				point(),
				point({ organizationId: "org2", chunkIndex: 1 }),
			]),
		).rejects.toThrow(/one organization's points per call/);
		expect(upsertMock).not.toHaveBeenCalled();
	});

	it("refuses a point without an organization, a source or a model", async () => {
		await expect(
			storeCompanyContextPoint(point({ organizationId: "" })),
		).rejects.toThrow(/organizationId/);
		await expect(
			storeCompanyContextPoint(point({ sourceId: "" })),
		).rejects.toThrow(/source and row ids/);
		await expect(
			storeCompanyContextPoint(point({ embeddingModel: "" })),
		).rejects.toThrow(/embedding model/);
		expect(getCollectionLayoutMock).not.toHaveBeenCalled();
		expect(upsertMock).not.toHaveBeenCalled();
	});

	it("throws when Qdrant rejects the write", async () => {
		upsertMock.mockRejectedValue(new Error("Bad Request"));

		await expect(storeCompanyContextPoint(point())).rejects.toThrow(
			"Failed to store company context points: Bad Request",
		);
	});

	it("writes nothing for no points", async () => {
		await expect(storeCompanyContextPoints([])).resolves.toEqual([]);
		expect(getCollectionLayoutMock).not.toHaveBeenCalled();
	});
});

describe("deleteCompanyContextSourcePoints", () => {
	it("deletes every point of the source by originalContextId, scoped to the organization", async () => {
		const result = await deleteCompanyContextSourcePoints({
			organizationId: ORG,
			sourceId: "src-1",
		});

		expect(result).toEqual({ collectionExists: true });
		expect(collectionExistsUncachedMock).toHaveBeenCalledWith(COLLECTION);
		expect(deleteMock).toHaveBeenCalledWith(COLLECTION, {
			wait: true,
			filter: {
				must: [
					{ key: "organizationId", match: { value: ORG } },
					{ key: "originalContextId", match: { value: "src-1" } },
				],
			},
		});
	});

	it("reports a missing collection as nothing to delete, and never creates one", async () => {
		collectionExistsUncachedMock.mockResolvedValue(false);

		const result = await deleteCompanyContextSourcePoints({
			organizationId: ORG,
			sourceId: "src-1",
		});

		expect(result).toEqual({ collectionExists: false });
		expect(deleteMock).not.toHaveBeenCalled();
		expect(ensureCollectionMock).not.toHaveBeenCalled();
		expect(getCollectionLayoutMock).not.toHaveBeenCalled();
	});

	it("throws when Qdrant fails, so the caller keeps the source row", async () => {
		deleteMock.mockRejectedValue(new Error("timeout"));

		await expect(
			deleteCompanyContextSourcePoints({
				organizationId: ORG,
				sourceId: "src-1",
			}),
		).rejects.toThrow("Failed to delete company context points: timeout");
	});

	it("throws when the existence check fails, rather than reading it as empty", async () => {
		collectionExistsUncachedMock.mockRejectedValue(
			new Error("qdrant unreachable"),
		);

		await expect(
			deleteCompanyContextSourcePoints({
				organizationId: ORG,
				sourceId: "src-1",
			}),
		).rejects.toThrow("qdrant unreachable");
		expect(deleteMock).not.toHaveBeenCalled();
	});

	it("refuses to run without an organization or a source", async () => {
		await expect(
			deleteCompanyContextSourcePoints({
				organizationId: "",
				sourceId: "src-1",
			}),
		).rejects.toThrow(/organizationId/);
		await expect(
			deleteCompanyContextSourcePoints({
				organizationId: ORG,
				sourceId: "",
			}),
		).rejects.toThrow(/sourceId/);
		expect(collectionExistsUncachedMock).not.toHaveBeenCalled();
		expect(deleteMock).not.toHaveBeenCalled();
	});
});

describe("deleteCompanyContextRowPoints", () => {
	it("deletes the points written from the given rows by contextId, in batches", async () => {
		const pageIds = Array.from({ length: 150 }, (_, i) => `page-${i}`);

		await deleteCompanyContextRowPoints({
			organizationId: ORG,
			contextIds: [...pageIds, "page-0"],
		});

		expect(deleteMock).toHaveBeenCalledTimes(2);
		const [firstBatch, secondBatch] = deleteMock.mock.calls.map(
			(call) => call[1].filter.must,
		);
		expect(firstBatch[0]).toEqual({
			key: "organizationId",
			match: { value: ORG },
		});
		expect(firstBatch[1].key).toBe("contextId");
		expect(firstBatch[1].match.any).toHaveLength(100);
		// Duplicates collapse.
		expect(secondBatch[1].match.any).toHaveLength(50);
	});

	it("still verifies the collection for no rows, deleting nothing", async () => {
		collectionExistsUncachedMock.mockResolvedValue(false);

		await expect(
			deleteCompanyContextRowPoints({
				organizationId: ORG,
				contextIds: [],
			}),
		).resolves.toEqual({ collectionExists: false });
		expect(collectionExistsUncachedMock).toHaveBeenCalledWith(COLLECTION);
		expect(deleteMock).not.toHaveBeenCalled();
	});
});

describe("deleteCompanyPagePointsNotIn", () => {
	type Condition = {
		key: string;
		match: { value?: string; any?: string[] };
	};
	type Filter = { must: Condition[]; must_not?: Condition[] };

	/** Qdrant's reading of a filter over one payload. */
	function deletes(filter: Filter, payload: Record<string, unknown>) {
		const holds = ({ key, match }: Condition) =>
			match.any !== undefined
				? match.any.includes(payload[key] as string)
				: payload[key] === match.value;
		return filter.must.every(holds) && !(filter.must_not ?? []).some(holds);
	}

	const payload = (contextId: string, parentContextId: string | null) => ({
		organizationId: ORG,
		originalContextId: parentContextId ?? contextId,
		contextId,
		parentContextId,
	});

	it("deletes the source's page points outside the live pages, and nothing else, in one request", async () => {
		await deleteCompanyPagePointsNotIn({
			organizationId: ORG,
			sourceId: "src-1",
			livePageIds: ["page-live", "page-live"],
		});

		expect(deleteMock).toHaveBeenCalledTimes(1);
		const [collection, request] = deleteMock.mock.calls[0];
		expect(collection).toBe(COLLECTION);
		expect(request).toEqual({
			wait: true,
			filter: {
				must: [
					{ key: "organizationId", match: { value: ORG } },
					{ key: "parentContextId", match: { value: "src-1" } },
				],
				must_not: [{ key: "contextId", match: { any: ["page-live"] } }],
			},
		});

		const { filter } = request as { filter: Filter };
		// A page whose row is gone goes.
		expect(deletes(filter, payload("page-gone", "src-1"))).toBe(true);
		// A live page, the source's own chunks and another source's page stay.
		expect(deletes(filter, payload("page-live", "src-1"))).toBe(false);
		expect(deletes(filter, payload("src-1", null))).toBe(false);
		expect(deletes(filter, payload("page-other", "src-2"))).toBe(false);
	});

	it("keeps every live page across batches of ids", async () => {
		const livePageIds = Array.from({ length: 150 }, (_, i) => `page-${i}`);

		await deleteCompanyPagePointsNotIn({
			organizationId: ORG,
			sourceId: "src-1",
			livePageIds,
		});

		expect(deleteMock).toHaveBeenCalledTimes(1);
		const { filter } = deleteMock.mock.calls[0][1] as { filter: Filter };
		expect(filter.must_not).toHaveLength(2);
		for (const id of livePageIds) {
			expect(deletes(filter, payload(id, "src-1"))).toBe(false);
		}
		expect(deletes(filter, payload("page-150", "src-1"))).toBe(true);
	});

	it("with no live page, deletes every page point of the source but not its own", async () => {
		await deleteCompanyPagePointsNotIn({
			organizationId: ORG,
			sourceId: "src-1",
			livePageIds: [],
		});

		const { filter } = deleteMock.mock.calls[0][1] as { filter: Filter };
		expect(filter).not.toHaveProperty("must_not");
		expect(deletes(filter, payload("page-1", "src-1"))).toBe(true);
		expect(deletes(filter, payload("src-1", null))).toBe(false);
	});

	it("reports a missing collection as nothing to delete, and never creates one", async () => {
		collectionExistsUncachedMock.mockResolvedValue(false);

		await expect(
			deleteCompanyPagePointsNotIn({
				organizationId: ORG,
				sourceId: "src-1",
				livePageIds: ["page-1"],
			}),
		).resolves.toEqual({ collectionExists: false });
		expect(deleteMock).not.toHaveBeenCalled();
		expect(ensureCollectionMock).not.toHaveBeenCalled();
	});

	it("throws when Qdrant fails, and refuses to run without an organization or a source", async () => {
		deleteMock.mockRejectedValue(new Error("timeout"));
		await expect(
			deleteCompanyPagePointsNotIn({
				organizationId: ORG,
				sourceId: "src-1",
				livePageIds: [],
			}),
		).rejects.toThrow("Failed to delete company context points: timeout");

		deleteMock.mockClear();
		await expect(
			deleteCompanyPagePointsNotIn({
				organizationId: "",
				sourceId: "src-1",
				livePageIds: [],
			}),
		).rejects.toThrow(/organizationId/);
		await expect(
			deleteCompanyPagePointsNotIn({
				organizationId: ORG,
				sourceId: "",
				livePageIds: [],
			}),
		).rejects.toThrow(/sourceId/);
		expect(deleteMock).not.toHaveBeenCalled();
	});
});
