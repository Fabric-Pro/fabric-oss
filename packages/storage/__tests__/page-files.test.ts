/**
 * Deleting a page's files.
 *
 * The files of one page share a prefix, so they are found by listing it. These
 * pin which bucket and prefix are listed (an upload under any other key would
 * outlive its page), that every page of a long listing is deleted, and that a
 * file that could not be deleted is reported rather than counted as removed.
 *
 * Run with: pnpm --filter @repo/storage test __tests__/page-files.test.ts
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockListObjects, mockDeleteObjects } = vi.hoisted(() => ({
	mockListObjects: vi.fn(),
	mockDeleteObjects: vi.fn(),
}));

vi.mock("../provider", () => ({
	getStorageProvider: () => ({
		listObjects: mockListObjects,
		deleteObjects: mockDeleteObjects,
	}),
}));

import { deleteFramePageFiles, PageFilesNotDeletedError } from "../page-files";

const page = { organizationId: "org-1", userId: "owner-1", frameId: "frame-1" };
const options = { bucket: "workspace-docs" };

const objects = (...keys: string[]) =>
	keys.map((key) => ({ key, lastModified: new Date(), size: 1 }));

beforeEach(() => {
	mockListObjects.mockReset();
	mockDeleteObjects.mockReset();
	mockListObjects.mockResolvedValue({ objects: [] });
	mockDeleteObjects.mockImplementation(async (keys: string[]) => ({
		deleted: keys.length,
		errors: [],
	}));
});

describe("deleteFramePageFiles", () => {
	it("lists the page's own prefix in the bucket it is given", async () => {
		await deleteFramePageFiles(page, options);

		expect(mockListObjects).toHaveBeenCalledWith({
			bucket: "workspace-docs",
			prefix: "org-1/frames/frame-1/files/",
			continuationToken: undefined,
		});
	});

	it("keys a page with no organization under its owner", async () => {
		await deleteFramePageFiles({ ...page, organizationId: null }, options);

		expect(mockListObjects).toHaveBeenCalledWith(
			expect.objectContaining({
				prefix: "owner-1/frames/frame-1/files/",
			}),
		);
	});

	it("deletes what the listing returns and counts it", async () => {
		mockListObjects.mockResolvedValue({
			objects: objects(
				"org-1/frames/frame-1/files/a",
				"org-1/frames/frame-1/files/b",
			),
		});

		const result = await deleteFramePageFiles(page, options);

		expect(mockDeleteObjects).toHaveBeenCalledWith(
			["org-1/frames/frame-1/files/a", "org-1/frames/frame-1/files/b"],
			{ bucket: "workspace-docs" },
		);
		expect(result).toEqual({ deleted: 2 });
	});

	it("walks every page of a long listing", async () => {
		mockListObjects
			.mockResolvedValueOnce({
				objects: objects("k1", "k2"),
				nextContinuationToken: "t1",
			})
			.mockResolvedValueOnce({
				objects: objects("k3"),
				nextContinuationToken: "t2",
			})
			.mockResolvedValueOnce({ objects: objects("k4") });

		const result = await deleteFramePageFiles(page, options);

		expect(
			mockListObjects.mock.calls.map(([args]) => args.continuationToken),
		).toEqual([undefined, "t1", "t2"]);
		expect(result).toEqual({ deleted: 4 });
	});

	it("deletes nothing and asks nothing of the store for a page with no files", async () => {
		const result = await deleteFramePageFiles(page, options);

		expect(mockDeleteObjects).not.toHaveBeenCalled();
		expect(result).toEqual({ deleted: 0 });
	});

	it("reports files that could not be deleted, after trying the rest, with the count only", async () => {
		mockListObjects
			.mockResolvedValueOnce({
				objects: objects("k1", "k2"),
				nextContinuationToken: "t1",
			})
			.mockResolvedValueOnce({ objects: objects("k3") });
		mockDeleteObjects
			.mockResolvedValueOnce({
				deleted: 1,
				errors: [{ key: "org-1/secret-key", message: "denied" }],
			})
			.mockResolvedValueOnce({ deleted: 1, errors: [] });

		const failure = await deleteFramePageFiles(page, options).then(
			() => null,
			(error: unknown) => error,
		);

		expect(failure).toBeInstanceOf(PageFilesNotDeletedError);
		expect((failure as PageFilesNotDeletedError).failed).toBe(1);
		expect((failure as Error).message).not.toContain("secret-key");
		expect(mockDeleteObjects).toHaveBeenCalledTimes(2);
	});

	it("lets a store failure while listing surface", async () => {
		mockListObjects.mockRejectedValue(new Error("storage unreachable"));

		await expect(deleteFramePageFiles(page, options)).rejects.toThrow(
			"storage unreachable",
		);
	});
});
