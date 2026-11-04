/**
 * A collection-existence check that Qdrant does not answer must not be read as
 * "the collection is missing" (Fizzy #3540). While Qdrant restarted, the old
 * behavior sent every caller on to create collections that already existed.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const {
	getCollectionsMock,
	getCollectionMock,
	createCollectionMock,
	createPayloadIndexMock,
} = vi.hoisted(() => ({
	getCollectionsMock: vi.fn(),
	getCollectionMock: vi.fn(),
	createCollectionMock: vi.fn(),
	createPayloadIndexMock: vi.fn(),
}));

vi.mock("../../vector-store/client", () => ({
	qdrantClient: {
		getCollections: getCollectionsMock,
		getCollection: getCollectionMock,
		createCollection: createCollectionMock,
		createPayloadIndex: createPayloadIndexMock,
	},
	DISTANCE_METRIC: "Cosine",
	VECTOR_SIZE: 1536,
}));

vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { clearCollectionCache, ensureCollection } from "../index";

// The shape the Qdrant REST client throws for a 503 (ApiError: status + message).
function serviceUnavailable(): Error {
	return Object.assign(new Error("Service Unavailable"), {
		status: 503,
		statusText: "Service Unavailable",
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	clearCollectionCache();
	createCollectionMock.mockResolvedValue(true);
	createPayloadIndexMock.mockResolvedValue(undefined);
});

describe("collection existence check", () => {
	it("fails without creating when Qdrant does not answer", async () => {
		getCollectionsMock.mockRejectedValue(serviceUnavailable());

		await expect(
			ensureCollection("company-contexts", "org-x"),
		).rejects.toMatchObject({ status: 503 });
		expect(createCollectionMock).not.toHaveBeenCalled();
	});

	it("does not cache the failure: the next call asks Qdrant again", async () => {
		getCollectionsMock.mockRejectedValueOnce(serviceUnavailable());
		await expect(
			ensureCollection("company-contexts", "org-x"),
		).rejects.toThrow("Service Unavailable");

		getCollectionsMock.mockResolvedValue({ collections: [] });
		await expect(
			ensureCollection("company-contexts", "org-x"),
		).resolves.toBe("company-contexts-org-org-x");
		expect(getCollectionsMock).toHaveBeenCalledTimes(2);
		expect(createCollectionMock).toHaveBeenCalledTimes(1);
	});

	it("still creates on a definite answer that the collection is absent", async () => {
		getCollectionsMock.mockResolvedValue({
			collections: [{ name: "company-contexts-org-other" }],
		});

		await ensureCollection("company-contexts", "org-x");
		expect(createCollectionMock).toHaveBeenCalledWith(
			"company-contexts-org-org-x",
			expect.anything(),
		);
	});

	it("keeps reporting an auth failure as an auth failure", async () => {
		getCollectionsMock.mockRejectedValue(new Error("Forbidden"));

		await expect(
			ensureCollection("company-contexts", "org-x"),
		).rejects.toThrow(/Qdrant authentication failed/);
		expect(createCollectionMock).not.toHaveBeenCalled();
	});
});
