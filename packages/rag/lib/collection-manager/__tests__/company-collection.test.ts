/**
 * The company-context vector collection (Fizzy #2719).
 *
 * Company vectors live in their own per-organization collection, apart from
 * every project's, so a project search never opens them. There is no shared
 * personal collection for them: resolving or ensuring the collection without
 * an organization must throw rather than fall back to the bare base name,
 * which would pool every organization's company material in one place.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const {
	getCollectionsMock,
	getCollectionMock,
	createCollectionMock,
	createPayloadIndexMock,
	deleteCollectionMock,
} = vi.hoisted(() => ({
	getCollectionsMock: vi.fn(),
	getCollectionMock: vi.fn(),
	createCollectionMock: vi.fn(),
	createPayloadIndexMock: vi.fn(),
	deleteCollectionMock: vi.fn(),
}));

vi.mock("../../vector-store/client", () => ({
	qdrantClient: {
		getCollections: getCollectionsMock,
		getCollection: getCollectionMock,
		createCollection: createCollectionMock,
		createPayloadIndex: createPayloadIndexMock,
		deleteCollection: deleteCollectionMock,
	},
	DISTANCE_METRIC: "Cosine",
	VECTOR_SIZE: 1536,
}));

vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
	COMPANY_CONTEXTS_BASE_COLLECTION,
	clearCollectionCache,
	deleteOrganizationCollections,
	ensureCollection,
	getCollectionName,
} from "../index";

beforeEach(() => {
	vi.clearAllMocks();
	clearCollectionCache();
	getCollectionsMock.mockResolvedValue({ collections: [] });
	createCollectionMock.mockResolvedValue(true);
	createPayloadIndexMock.mockResolvedValue(undefined);
	deleteCollectionMock.mockResolvedValue(true);
});

describe("company-contexts collection", () => {
	it("is named per organization", () => {
		expect(COMPANY_CONTEXTS_BASE_COLLECTION).toBe("company-contexts");
		expect(getCollectionName("company-contexts", "org-x")).toBe(
			"company-contexts-org-org-x",
		);
	});

	it.each([null, undefined, ""])(
		"refuses to resolve without an organization (%s)",
		(organizationId) => {
			expect(() =>
				getCollectionName("company-contexts", organizationId),
			).toThrow(/requires an organization/);
		},
	);

	it("refuses to ensure the collection without an organization, creating nothing", async () => {
		await expect(
			ensureCollection("company-contexts", null),
		).rejects.toThrow(/requires an organization/);
		expect(createCollectionMock).not.toHaveBeenCalled();
	});

	// Project collections keep their shared personal fallback.
	it("leaves the project collection's personal fallback alone", () => {
		expect(getCollectionName("project-contexts", null)).toBe(
			"project-contexts",
		);
	});

	it("creates the organization's collection with the keys retrieval and deletion filter on", async () => {
		await expect(
			ensureCollection("company-contexts", "org-x"),
		).resolves.toBe("company-contexts-org-org-x");

		expect(createCollectionMock).toHaveBeenCalledWith(
			"company-contexts-org-org-x",
			expect.objectContaining({
				vectors: { dense: expect.objectContaining({ size: 1536 }) },
				sparse_vectors: { sparse: {} },
			}),
		);
		const indexed = createPayloadIndexMock.mock.calls.map(
			([, index]) => index.field_name,
		);
		expect(indexed).toEqual(
			expect.arrayContaining([
				"organizationId",
				"contextId",
				// The chunk deleter's filter key: unindexed, Qdrant rejects it.
				"originalContextId",
				"parentContextId",
				"contextType",
				"embeddingModel",
			]),
		);
	});

	it("is dropped with the organization's other collections", async () => {
		getCollectionsMock.mockResolvedValue({
			collections: [
				{ name: "company-contexts-org-org-x" },
				{ name: "company-contexts-org-org-y" },
			],
		});

		await deleteOrganizationCollections("org-x");

		expect(deleteCollectionMock).toHaveBeenCalledTimes(1);
		expect(deleteCollectionMock).toHaveBeenCalledWith(
			"company-contexts-org-org-x",
		);
	});
});
