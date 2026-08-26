/**
 * Tests for `pruneOrphanUrlPagesActivity`.
 *
 * Covers the workflow's "Pages indexed > Max pages" trim: rows whose URL
 * the most recent crawl did not return are deleted; rows that were re-
 * crawled survive. Defensive case: empty `keptUrls` is a no-op so we
 * never accidentally wipe the child table.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/database/prisma/client", () => ({
	db: {
		projectContextUrlPage: {
			deleteMany: vi.fn(),
		},
	},
}));

vi.mock("../../src/activities/lib/activity-logger", () => ({
	activityLogger: {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	},
}));

import { db } from "@repo/database/prisma/client";
import { pruneOrphanUrlPagesActivity } from "../../src/activities/url-source/prune-orphan-url-pages-activity";

const mockDeleteMany = db.projectContextUrlPage.deleteMany as ReturnType<
	typeof vi.fn
>;

describe("pruneOrphanUrlPagesActivity", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("deletes rows whose pageUrl is NOT in the keptUrls set", async () => {
		mockDeleteMany.mockResolvedValue({ count: 23 });

		const result = await pruneOrphanUrlPagesActivity({
			parentContextId: "ctx-1",
			keptUrls: [
				"https://example.com/a",
				"https://example.com/b",
				"https://example.com/c",
			],
		});

		expect(mockDeleteMany).toHaveBeenCalledOnce();
		expect(mockDeleteMany.mock.calls[0][0]).toEqual({
			where: {
				parentContextId: "ctx-1",
				pageUrl: {
					notIn: [
						"https://example.com/a",
						"https://example.com/b",
						"https://example.com/c",
					],
				},
			},
		});
		expect(result).toEqual({ deletedCount: 23 });
	});

	it("returns deletedCount=0 and skips the query when keptUrls is empty", async () => {
		// Defensive: an empty crawl result is either a transient hiccup or
		// a scope change. Either way, we do NOT wipe the existing children;
		// the user's previously-indexed pages survive and the workflow's
		// failure / next-run logic decides what's next.
		const result = await pruneOrphanUrlPagesActivity({
			parentContextId: "ctx-1",
			keptUrls: [],
		});

		expect(mockDeleteMany).not.toHaveBeenCalled();
		expect(result).toEqual({ deletedCount: 0 });
	});

	it("swallows DB errors so the workflow's finalize step still runs", async () => {
		mockDeleteMany.mockRejectedValue(new Error("connection reset"));

		const result = await pruneOrphanUrlPagesActivity({
			parentContextId: "ctx-1",
			keptUrls: ["https://example.com/a"],
		});

		// Best-effort: error path returns 0 rather than throwing — the
		// workflow's outer catch would otherwise mark the whole crawl
		// FAILED for a recoverable cleanup miss.
		expect(result).toEqual({ deletedCount: 0 });
	});
});
