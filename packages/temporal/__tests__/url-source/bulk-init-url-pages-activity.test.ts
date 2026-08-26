/**
 * Tests for `bulkInitUrlPagesActivity`.
 *
 * Pre-creates PENDING placeholder rows so the UI can show the full URL set
 * at the start of a crawl instead of dripping rows in one-by-one. The
 * activity must be:
 *   - Idempotent — re-runs on a partial crawl don't overwrite existing
 *     content rows.
 *   - Concurrency-safe — `createMany({ skipDuplicates })` swallows races.
 *   - Cheap — single bulk insert, no N+1 round trips.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/database/prisma/client", () => ({
	db: {
		projectContextUrlPage: {
			findMany: vi.fn(),
			createMany: vi.fn(),
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
import { bulkInitUrlPagesActivity } from "../../src/activities/url-source/bulk-init-url-pages-activity";

const mockFindMany = db.projectContextUrlPage.findMany as ReturnType<
	typeof vi.fn
>;
const mockCreateMany = db.projectContextUrlPage.createMany as ReturnType<
	typeof vi.fn
>;

describe("bulkInitUrlPagesActivity", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("creates PENDING rows for every URL when the parent has no prior pages", async () => {
		mockFindMany.mockResolvedValueOnce([]);
		mockCreateMany.mockResolvedValueOnce({ count: 3 });

		const result = await bulkInitUrlPagesActivity({
			parentContextId: "ctx-1",
			projectId: "proj-1",
			urls: [
				"https://help.acme.com/hc/en-us/articles/1",
				"https://help.acme.com/hc/en-us/articles/2",
				"https://help.acme.com/hc/en-us/articles/3",
			],
			userId: "user-1",
			organizationId: null,
		});

		expect(mockCreateMany).toHaveBeenCalledOnce();
		const callArg = mockCreateMany.mock.calls[0][0];
		expect(callArg.data).toHaveLength(3);
		expect(callArg.data[0]).toMatchObject({
			parentContextId: "ctx-1",
			projectId: "proj-1",
			pageUrl: "https://help.acme.com/hc/en-us/articles/1",
			extractionStatus: "PENDING",
			userId: "user-1",
			organizationId: null,
		});
		// `skipDuplicates: true` is a defensive race-guard — verifies the
		// activity won't throw on a concurrent insert from another tab.
		expect(callArg.skipDuplicates).toBe(true);
		expect(result).toEqual({
			totalCount: 3,
			createdCount: 3,
			existingCount: 0,
		});
	});

	it("is idempotent: skips URLs already present under the parent", async () => {
		// Simulates a re-sync where 2 of 3 URLs were created by a prior
		// partial crawl. Only the third needs to be inserted.
		mockFindMany.mockResolvedValueOnce([
			{ pageUrl: "https://help.acme.com/hc/en-us/articles/1" },
			{ pageUrl: "https://help.acme.com/hc/en-us/articles/2" },
		]);
		mockCreateMany.mockResolvedValueOnce({ count: 1 });

		const result = await bulkInitUrlPagesActivity({
			parentContextId: "ctx-1",
			projectId: "proj-1",
			urls: [
				"https://help.acme.com/hc/en-us/articles/1",
				"https://help.acme.com/hc/en-us/articles/2",
				"https://help.acme.com/hc/en-us/articles/3",
			],
			userId: "user-1",
			organizationId: null,
		});

		const callArg = mockCreateMany.mock.calls[0][0];
		expect(callArg.data).toHaveLength(1);
		expect(callArg.data[0].pageUrl).toBe(
			"https://help.acme.com/hc/en-us/articles/3",
		);
		expect(result).toEqual({
			totalCount: 3,
			createdCount: 1,
			existingCount: 2,
		});
	});

	it("short-circuits and never calls createMany when every URL already exists", async () => {
		mockFindMany.mockResolvedValueOnce([
			{ pageUrl: "https://help.acme.com/hc/en-us/articles/1" },
			{ pageUrl: "https://help.acme.com/hc/en-us/articles/2" },
		]);

		const result = await bulkInitUrlPagesActivity({
			parentContextId: "ctx-1",
			projectId: "proj-1",
			urls: [
				"https://help.acme.com/hc/en-us/articles/1",
				"https://help.acme.com/hc/en-us/articles/2",
			],
			userId: "user-1",
			organizationId: null,
		});

		expect(mockCreateMany).not.toHaveBeenCalled();
		expect(result).toEqual({
			totalCount: 2,
			createdCount: 0,
			existingCount: 2,
		});
	});

	it("returns 0 counts and skips queries when urls is empty", async () => {
		const result = await bulkInitUrlPagesActivity({
			parentContextId: "ctx-1",
			projectId: "proj-1",
			urls: [],
			userId: "user-1",
			organizationId: null,
		});

		expect(mockFindMany).not.toHaveBeenCalled();
		expect(mockCreateMany).not.toHaveBeenCalled();
		expect(result).toEqual({
			totalCount: 0,
			createdCount: 0,
			existingCount: 0,
		});
	});

	it("preserves the tenant XOR pair (userId + organizationId) on every inserted row", async () => {
		// Org-context crawl: userId is the owner, organizationId is set,
		// both must appear on each child row so RLS works.
		mockFindMany.mockResolvedValueOnce([]);
		mockCreateMany.mockResolvedValueOnce({ count: 2 });

		await bulkInitUrlPagesActivity({
			parentContextId: "ctx-1",
			projectId: "proj-1",
			urls: ["https://x.com/a", "https://x.com/b"],
			userId: "user-1",
			organizationId: "org-1",
		});

		const data = mockCreateMany.mock.calls[0][0].data;
		for (const row of data) {
			expect(row.userId).toBe("user-1");
			expect(row.organizationId).toBe("org-1");
		}
	});
});
