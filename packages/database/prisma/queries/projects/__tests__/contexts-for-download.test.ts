/**
 * Unit tests for `listContextsForDownload`'s select shape.
 *
 * Prisma is mocked (no Postgres required) — what matters here is which
 * columns the batch export is handed. `urlScope` in particular: a `LINK`
 * crawled with `PATH_PREFIX` keeps its markdown in child
 * `ProjectContextUrlPage` rows and leaves `content` empty on the parent, so
 * without that column the batch export cannot tell a crawled link apart from
 * an empty one and drops it — while the single-item download exports the same
 * row fine (Fizzy #2228).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockFindMany } = vi.hoisted(() => ({
	mockFindMany: vi.fn(),
}));

vi.mock("../../../client", () => ({
	db: {
		projectContext: {
			findMany: mockFindMany,
		},
	},
	Prisma: {},
}));

import { listContextsForDownload } from "../contexts";

describe("listContextsForDownload", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockFindMany.mockResolvedValue([]);
	});

	it("selects urlScope so a crawled PATH_PREFIX link is recognisable", async () => {
		await listContextsForDownload("proj-1");

		const args = mockFindMany.mock.calls[0][0];
		expect(args.select.urlScope).toBe(true);
	});

	it("keeps the columns the batch export already depends on", async () => {
		await listContextsForDownload("proj-1");

		const args = mockFindMany.mock.calls[0][0];
		for (const column of [
			"id",
			"type",
			"content",
			"s3Path",
			"s3Bucket",
			"originalFilename",
			"mimeType",
			"fileSize",
			"sourceTitle",
			"sourceUrl",
			"extractionStatus",
			"metadata",
			"createdAt",
		]) {
			expect(args.select[column]).toBe(true);
		}
	});

	it("scopes to the project and orders by createdAt ascending", async () => {
		await listContextsForDownload("proj-1");

		const args = mockFindMany.mock.calls[0][0];
		expect(args.where).toEqual({ projectId: "proj-1" });
		expect(args.orderBy[0]).toEqual({ createdAt: "asc" });
	});

	it("breaks createdAt ties on id so the export order is total", async () => {
		// The batch export truncates at an item ceiling instead of refusing
		// (Fizzy #2228). It takes a prefix of this list, so rows sharing a
		// `createdAt` — everything written in one transaction — must not be
		// free to come back in a different order on the next export, or two
		// exports of an unchanged project would drop different rows.
		await listContextsForDownload("proj-1");

		const args = mockFindMany.mock.calls[0][0];
		expect(args.orderBy).toEqual([{ createdAt: "asc" }, { id: "asc" }]);
	});
});
