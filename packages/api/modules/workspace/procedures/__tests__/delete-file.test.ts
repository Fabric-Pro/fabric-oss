/**
 * `DELETE /workspace/files/{id}` deletes a workspace file, never a page.
 *
 * A page's stored files and records are cleaned up with it by `frames.delete`,
 * which deletes the files before the row so a failure leaves the page to retry.
 * A frame or slideshow row removed through this route would leave its stored
 * files behind with nothing pointing at them, so the route refuses those rows
 * and deletes nothing.
 *
 * Run with: pnpm --filter @repo/api test modules/workspace/procedures/__tests__/delete-file.test.ts
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { handlers, mockGetFile, mockDeleteFile } = vi.hoisted(() => ({
	handlers: {} as Record<string, (...args: unknown[]) => unknown>,
	mockGetFile: vi.fn(),
	mockDeleteFile: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	deleteWorkspaceFile: mockDeleteFile,
	getWorkspaceFileById: mockGetFile,
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
	};
});

import "../delete-file";

const remove = (userId = "owner-1") =>
	handlers["/workspace/files/{id}"]({
		input: { id: "file-1" },
		context: { user: { id: userId }, session: {} },
	});

const row = (fileType: string, userId = "owner-1") => ({
	id: "file-1",
	userId,
	fileType,
});

beforeEach(() => {
	vi.clearAllMocks();
	mockDeleteFile.mockResolvedValue({ id: "file-1" });
});

describe("workspace.deleteFile", () => {
	it.each(["DOCUMENT", "CODE", "DATA", "CONFIG", "OUTPUT", "ARTIFACT"])(
		"deletes the caller's own %s file",
		async (fileType) => {
			mockGetFile.mockResolvedValue(row(fileType));

			const result = await remove();

			expect(mockDeleteFile).toHaveBeenCalledWith("file-1");
			expect(result).toEqual({ success: true });
		},
	);

	it.each(["FRAME", "SLIDESHOW"])(
		"refuses a %s row, which frames.delete removes together with its stored files",
		async (fileType) => {
			mockGetFile.mockResolvedValue(row(fileType));

			await expect(remove()).rejects.toThrow(
				"A page is deleted from its own page, not as a file",
			);
			expect(mockDeleteFile).not.toHaveBeenCalled();
		},
	);

	it("answers a file that is not there as not found, and deletes nothing", async () => {
		mockGetFile.mockResolvedValue(null);

		await expect(remove()).rejects.toThrow("File not found");
		expect(mockDeleteFile).not.toHaveBeenCalled();
	});

	it("tells someone else's file from a page only after the owner check, so a stranger learns nothing of the row", async () => {
		mockGetFile.mockResolvedValue(row("FRAME", "someone-else"));

		await expect(remove()).rejects.toThrow("Access denied");
		expect(mockDeleteFile).not.toHaveBeenCalled();
	});
});
