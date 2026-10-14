/**
 * Unit tests for `listStoredSourceContexts` — the lookup behind an imported
 * document's "Original file" download (Fizzy #2280).
 *
 * Prisma is mocked (no Postgres required). What matters is the filter: only
 * rows of the caller's project, only rows that still hold a stored object, and
 * only the columns the documents list needs — never the storage key itself.
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

import { listStoredSourceContexts } from "../contexts";

describe("listStoredSourceContexts", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockFindMany.mockResolvedValue([]);
	});

	it("reads only this project's rows that still hold a stored file", async () => {
		await listStoredSourceContexts("proj-1", ["ctx-a", "ctx-b"]);

		expect(mockFindMany).toHaveBeenCalledWith({
			where: {
				id: { in: ["ctx-a", "ctx-b"] },
				projectId: "proj-1",
				s3Path: { not: null },
			},
			select: { id: true, type: true, originalFilename: true },
		});
	});

	it("asks nothing when no document names a source", async () => {
		await expect(listStoredSourceContexts("proj-1", [])).resolves.toEqual(
			[],
		);
		expect(mockFindMany).not.toHaveBeenCalled();
	});
});
