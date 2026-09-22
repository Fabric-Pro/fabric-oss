/**
 * `deleteProjectContext(..., { strict: true })` (Fizzy #2616).
 *
 * The default delete tolerates a failed filter delete and falls back to the
 * base point id, which suits removing a context whose older points may lack
 * the filtered payload fields. A re-embed cannot tolerate it: the filter
 * delete is the only thing that removes `<contextId>-chunk-N` points, so a
 * swallowed failure leaves a shrunk file's stale tail answering searches.
 * `strict` makes that failure propagate; the default is pinned unchanged.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { deleteMock, ensureCollectionMock } = vi.hoisted(() => ({
	deleteMock: vi.fn(),
	ensureCollectionMock: vi.fn(),
}));

vi.mock("../client", () => ({
	qdrantClient: { delete: deleteMock },
}));

vi.mock("../../collection-manager", () => ({
	ensureCollection: ensureCollectionMock,
	getCollectionLayout: vi.fn(),
}));

vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { deleteProjectContext } from "../store";

function filterDeleteFails() {
	deleteMock.mockImplementation(
		async (_collection: string, body: { filter?: unknown }) => {
			if (body.filter) {
				throw new Error("qdrant unavailable");
			}
			return { status: "completed" };
		},
	);
}

beforeEach(() => {
	vi.clearAllMocks();
	ensureCollectionMock.mockResolvedValue("project-contexts-org-1");
	deleteMock.mockResolvedValue({ status: "completed" });
});

describe("deleteProjectContext", () => {
	it("by default falls back to the base point when the filter delete fails", async () => {
		filterDeleteFails();

		await expect(
			deleteProjectContext("ctx-1", "org-1"),
		).resolves.toBeUndefined();
		// The filter attempt, then the point-id fallback.
		expect(deleteMock).toHaveBeenCalledTimes(2);
		expect(deleteMock.mock.calls[1][1]).toHaveProperty("points");
	});

	it("with strict, rejects when the filter delete fails and skips the fallback", async () => {
		filterDeleteFails();

		await expect(
			deleteProjectContext("ctx-1", "org-1", undefined, { strict: true }),
		).rejects.toThrow("qdrant unavailable");
		expect(deleteMock).toHaveBeenCalledTimes(1);
	});

	it("with strict, deletes by filter and by point id when both succeed", async () => {
		await deleteProjectContext("ctx-1", "org-1", undefined, {
			strict: true,
		});

		expect(deleteMock).toHaveBeenCalledTimes(2);
		expect(deleteMock.mock.calls[0][1]).toMatchObject({
			wait: true,
			filter: {
				should: [
					{ key: "originalContextId", match: { value: "ctx-1" } },
					{ key: "contextId", match: { value: "ctx-1" } },
				],
			},
		});
	});
});
