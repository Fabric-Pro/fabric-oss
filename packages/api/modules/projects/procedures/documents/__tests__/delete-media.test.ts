/**
 * Tests for deleteMediaProcedure
 *
 * Verifies S3 key prefix validation, deletion with error isolation, and
 * proper reporting of deleted count and errors. Authorization is enforced
 * by the `requireProjectPermission` middleware (covered by
 * permission-coverage + roles regression tests) — these handler-level
 * tests stub the middleware out and focus on behavior.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/config", () => ({
	config: {
		storage: {
			bucketNames: {
				projectContexts: "test-bucket",
			},
		},
	},
}));

const mockDeleteFile = vi.fn();
vi.mock("@repo/storage", () => ({
	getStorageProvider: vi.fn(() => ({
		type: "s3",
		deleteFile: mockDeleteFile,
	})),
}));

vi.mock("../../../../../orpc/procedures", () => {
	const chain: any = {
		use: () => chain,
		route: () => chain,
		input: () => chain,
		output: () => chain,
		handler: (fn: unknown) => ({ handler: fn }),
	};
	return {
		tenantProtectedProcedure: chain,
		Permissions: new Proxy({}, { get: (_t, p) => String(p) }),
		requirePermission: () => (c: unknown) => c,
		requireProjectPermission: () => (c: unknown) => c,
	};
});

describe("deleteMedia", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("rejects S3 keys that do not match the document prefix", async () => {
		const { deleteMediaProcedure } = await import("../delete-media");
		const handler = (deleteMediaProcedure as any).handler;

		await expect(
			handler({
				input: {
					projectId: "proj-1",
					documentId: "doc-1",
					s3Keys: ["document-media/wrong-proj/doc-1/img.png"],
				},
			}),
		).rejects.toThrow(/do not belong/i);
	});

	it("deletes files and returns count on success", async () => {
		mockDeleteFile.mockResolvedValue(undefined);

		const { deleteMediaProcedure } = await import("../delete-media");
		const handler = (deleteMediaProcedure as any).handler;

		const result = await handler({
			input: {
				projectId: "proj-1",
				documentId: "doc-1",
				s3Keys: [
					"document-media/proj-1/doc-1/a.png",
					"document-media/proj-1/doc-1/b.jpg",
				],
			},
		});

		expect(result.deleted).toBe(2);
		expect(result.errors).toHaveLength(0);
		expect(mockDeleteFile).toHaveBeenCalledTimes(2);
	});

	it("isolates errors per file and reports them", async () => {
		mockDeleteFile
			.mockResolvedValueOnce(undefined) // first succeeds
			.mockRejectedValueOnce(new Error("S3 error")); // second fails

		const { deleteMediaProcedure } = await import("../delete-media");
		const handler = (deleteMediaProcedure as any).handler;

		const result = await handler({
			input: {
				projectId: "proj-1",
				documentId: "doc-1",
				s3Keys: [
					"document-media/proj-1/doc-1/good.png",
					"document-media/proj-1/doc-1/bad.png",
				],
			},
		});

		expect(result.deleted).toBe(1);
		expect(result.errors).toHaveLength(1);
		expect(result.errors[0]).toContain("S3 error");
	});

	it("handles all deletions failing gracefully", async () => {
		mockDeleteFile.mockRejectedValue(new Error("Service unavailable"));

		const { deleteMediaProcedure } = await import("../delete-media");
		const handler = (deleteMediaProcedure as any).handler;

		const result = await handler({
			input: {
				projectId: "proj-1",
				documentId: "doc-1",
				s3Keys: ["document-media/proj-1/doc-1/a.png"],
			},
		});

		expect(result.deleted).toBe(0);
		expect(result.errors).toHaveLength(1);
	});
});
