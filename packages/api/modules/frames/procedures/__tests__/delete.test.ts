/**
 * Deleting a frame removes the files it stored, and only a frame that is gone
 * from the database loses its files.
 *
 * Files are deleted before the row so that a store that cannot be reached
 * leaves the page in place for a retry. A page with no file records never
 * reaches the object store.
 *
 * Run with: pnpm --filter @repo/api test modules/frames/procedures/__tests__/delete.test.ts
 */

import { ORPCError } from "@orpc/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
	handlers,
	mockGetFrameById,
	mockDeleteFrame,
	mockCountPageRecords,
	mockDeletePageFiles,
	order,
} = vi.hoisted(() => ({
	handlers: {} as Record<string, (...args: unknown[]) => unknown>,
	mockGetFrameById: vi.fn(),
	mockDeleteFrame: vi.fn(),
	mockCountPageRecords: vi.fn(),
	mockDeletePageFiles: vi.fn(),
	order: [] as string[],
}));

vi.mock("@repo/database", () => ({
	countPageRecords: mockCountPageRecords,
	deleteFrame: mockDeleteFrame,
	getFrameById: mockGetFrameById,
}));
vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@repo/storage", () => ({
	deleteFramePageFiles: mockDeletePageFiles,
}));
vi.mock("../../lib/page-files", () => ({
	PAGE_FILES_BUCKET: "workspace-docs",
}));

vi.mock("../../../../orpc/procedures", () => {
	let current = "";
	const chainable: any = {
		use: () => chainable,
		route: (route: { path: string }) => {
			current = route.path;
			return chainable;
		},
		input: () => chainable,
		output: () => chainable,
		handler: (fn: (...args: unknown[]) => unknown) => {
			handlers[current] = fn;
			return { _handler: fn };
		},
	};
	return {
		tenantProtectedProcedure: chainable,
		Permissions: new Proxy({}, { get: (_t, p) => String(p) }),
		requirePermission: () => (c: unknown) => c,
		resolveOrganizationId: vi.fn(
			(organizationId: string | null | undefined) =>
				organizationId ?? undefined,
		),
	};
});

import "../delete";

const remove = (organizationId: string | null = "org-1") =>
	handlers["/frames/{id}"]({
		input: { id: "frame-1", organizationId },
		context: { user: { id: "owner-1" }, session: {} },
	});

beforeEach(() => {
	vi.clearAllMocks();
	order.length = 0;
	mockGetFrameById.mockResolvedValue({ id: "frame-1", userId: "owner-1" });
	mockCountPageRecords.mockResolvedValue(0);
	mockDeletePageFiles.mockImplementation(async () => {
		order.push("files");
		return { deleted: 1 };
	});
	mockDeleteFrame.mockImplementation(async () => {
		order.push("frame");
		return { success: true };
	});
});

describe("frames.delete", () => {
	it("deletes the stored files of a page that has file records, before the page", async () => {
		mockCountPageRecords.mockResolvedValue(3);

		await expect(remove()).resolves.toEqual({ success: true });

		expect(mockCountPageRecords).toHaveBeenCalledWith({
			frameId: "frame-1",
			organizationId: "org-1",
			collection: "$files",
		});
		expect(mockDeletePageFiles).toHaveBeenCalledWith(
			{
				frameId: "frame-1",
				userId: "owner-1",
				organizationId: "org-1",
			},
			{ bucket: "workspace-docs" },
		);
		expect(order).toEqual(["files", "frame"]);
	});

	it("keeps the page when its files cannot be deleted, so deleting it again retries", async () => {
		mockCountPageRecords.mockResolvedValue(3);
		mockDeletePageFiles.mockRejectedValue(new Error("storage unreachable"));

		const failure = await remove().then(
			() => null,
			(error: unknown) => error,
		);

		expect(failure).toBeInstanceOf(ORPCError);
		expect((failure as ORPCError<string, unknown>).code).toBe(
			"INTERNAL_SERVER_ERROR",
		);
		expect(mockDeleteFrame).not.toHaveBeenCalled();
	});

	it("never reaches the object store for a page with no file records", async () => {
		await expect(remove()).resolves.toEqual({ success: true });

		expect(mockDeletePageFiles).not.toHaveBeenCalled();
		expect(mockDeleteFrame).toHaveBeenCalledTimes(1);
	});

	it("deletes nothing for a frame the caller does not own", async () => {
		mockGetFrameById.mockResolvedValue(null);

		await expect(remove()).rejects.toThrow("Frame not found");

		expect(mockCountPageRecords).not.toHaveBeenCalled();
		expect(mockDeletePageFiles).not.toHaveBeenCalled();
		expect(mockDeleteFrame).not.toHaveBeenCalled();
	});

	it("passes the caller's organization to the lookup and the delete", async () => {
		await remove("org-9");

		expect(mockGetFrameById).toHaveBeenCalledWith({
			id: "frame-1",
			userId: "owner-1",
			organizationId: "org-9",
		});
		expect(mockDeleteFrame).toHaveBeenCalledWith({
			id: "frame-1",
			userId: "owner-1",
			organizationId: "org-9",
		});
	});

	it("skips the object store for a frame with no organization", async () => {
		await remove(null);

		expect(mockCountPageRecords).not.toHaveBeenCalled();
		expect(mockDeletePageFiles).not.toHaveBeenCalled();
		expect(mockDeleteFrame).toHaveBeenCalledTimes(1);
	});

	it("still reports a delete the database refused", async () => {
		mockDeleteFrame.mockResolvedValue({
			success: false,
			error: "Frame not found",
		});

		await expect(remove()).rejects.toThrow("Frame not found");
	});
});
