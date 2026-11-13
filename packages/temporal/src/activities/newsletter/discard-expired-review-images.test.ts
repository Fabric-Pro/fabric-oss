/**
 * Tests for `discardExpiredReviewImages` — the cleanup the scheduled dispatch
 * runs for a held draft the stale-review reclaim expired.
 *
 * Contract:
 *   - removes the draft's image rows (through the query, which only acts on
 *     a REJECTED or EXPIRED send of that project), then deletes the objects
 *     those rows held from the project-contexts bucket;
 *   - touches no storage when the draft had no images;
 *   - then clears the send's review folder (uploads never added), even when
 *     the rows could not be removed;
 *   - never throws: a failed row removal, a failed delete, or objects the
 *     delete left behind are logged and the dispatch carries on.
 */

import { config } from "@repo/config";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
	mockDeleteRows,
	mockDeleteObjects,
	mockDeleteFolder,
	mockWarn,
	TENANT,
} = vi.hoisted(() => ({
	mockDeleteRows: vi.fn(),
	mockDeleteObjects: vi.fn(),
	mockDeleteFolder: vi.fn(),
	mockWarn: vi.fn(),
	TENANT: { organizationId: "org-9", userId: "user-1" },
}));

vi.mock("@repo/database", () => ({
	deleteDiscardedNewsletterSendImages: (...a: unknown[]) =>
		mockDeleteRows(...a),
	getNewsletterProjectTenant: async () => TENANT,
}));

vi.mock(
	"@repo/database/prisma/queries/projects/newsletter-image-publish",
	() => ({
		deleteNewsletterSendFolder: (...a: unknown[]) => mockDeleteFolder(...a),
	}),
);

vi.mock("@repo/storage", () => ({
	deleteObjects: (...a: unknown[]) => mockDeleteObjects(...a),
}));

vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: mockWarn, error: vi.fn() },
}));

import { discardExpiredReviewImages } from "./discard-expired-review-images";

const BUCKET = config.storage.bucketNames.projectContexts;
const KEYS = [
	"org-9/newsletter-images/expired-1/one.png",
	"org-9/newsletter-images/expired-1/two.jpg",
];

beforeEach(() => {
	vi.clearAllMocks();
	mockDeleteRows.mockResolvedValue(KEYS);
	mockDeleteObjects.mockResolvedValue({ deleted: 2, errors: [] });
	mockDeleteFolder.mockResolvedValue(undefined);
});

describe("discardExpiredReviewImages", () => {
	it("removes the expired draft's image rows, then their objects", async () => {
		await discardExpiredReviewImages("proj-1", "expired-1");

		expect(mockDeleteRows).toHaveBeenCalledWith("proj-1", "expired-1");
		expect(mockDeleteObjects).toHaveBeenCalledWith(KEYS, {
			bucket: BUCKET,
		});
		expect(mockDeleteFolder).toHaveBeenCalledWith(TENANT, "expired-1");
		expect(mockWarn).not.toHaveBeenCalled();
	});

	it("touches no storage when the draft had no images", async () => {
		mockDeleteRows.mockResolvedValue([]);

		await discardExpiredReviewImages("proj-1", "expired-1");

		expect(mockDeleteObjects).not.toHaveBeenCalled();
	});

	it("logs and resolves when the rows cannot be removed", async () => {
		mockDeleteRows.mockRejectedValue(new Error("db blip"));

		await expect(
			discardExpiredReviewImages("proj-1", "expired-1"),
		).resolves.toBeUndefined();

		expect(mockDeleteObjects).not.toHaveBeenCalled();
		expect(mockWarn).toHaveBeenCalledWith(
			"[Newsletter] expired draft's images not removed",
			expect.objectContaining({ sendId: "expired-1" }),
		);
		expect(mockDeleteFolder).toHaveBeenCalledWith(TENANT, "expired-1");
	});

	it("logs and resolves when the delete throws", async () => {
		mockDeleteObjects.mockRejectedValue(new Error("storage down"));

		await expect(
			discardExpiredReviewImages("proj-1", "expired-1"),
		).resolves.toBeUndefined();

		expect(mockWarn).toHaveBeenCalledWith(
			"[Newsletter] expired draft's images not removed",
			expect.objectContaining({ sendId: "expired-1" }),
		);
	});

	it("logs the objects the delete left behind", async () => {
		mockDeleteObjects.mockResolvedValue({
			deleted: 1,
			errors: [{ key: KEYS[1], message: "AccessDenied" }],
		});

		await discardExpiredReviewImages("proj-1", "expired-1");

		expect(mockWarn).toHaveBeenCalledWith(
			"[Newsletter] expired draft's image objects left",
			{ sendId: "expired-1", count: 1 },
		);
	});
});
