/**
 * Tests for createMediaUploadUrlProcedure
 *
 * Verifies MIME type validation, document ownership check, and signed URL
 * generation. Authorization is enforced by the `requireProjectPermission`
 * middleware (covered by permission-coverage + roles regression tests) —
 * these handler-level tests stub the middleware out and focus on behavior.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", () => ({
	getDocumentById: vi.fn(),
}));

vi.mock("@repo/config", () => ({
	config: {
		storage: {
			bucketNames: {
				projectContexts: "test-bucket",
			},
		},
	},
}));

const mockGetSignedUploadUrl = vi.fn();
vi.mock("@repo/storage", () => ({
	getStorageProvider: vi.fn(() => ({
		type: "s3",
		supportsPresignedUrls: true,
		getSignedUploadUrl: mockGetSignedUploadUrl,
	})),
}));

// Mock the procedure base so we can test the handler directly
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

import { getDocumentById } from "@repo/database";

describe("createMediaUploadUrl", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("rejects unsupported MIME types", async () => {
		const { createMediaUploadUrlProcedure } = await import(
			"../create-media-upload-url"
		);
		const handler = (createMediaUploadUrlProcedure as any).handler;

		await expect(
			handler({
				input: {
					projectId: "proj-1",
					documentId: "doc-1",
					filename: "test.svg",
					mimeType: "image/svg+xml",
					size: 1024,
				},
			}),
		).rejects.toThrow(/unsupported image type/i);
	});

	it("rejects when document does not belong to project", async () => {
		vi.mocked(getDocumentById).mockResolvedValueOnce({
			id: "doc-1",
			project: { id: "other-project" },
		} as any);

		const { createMediaUploadUrlProcedure } = await import(
			"../create-media-upload-url"
		);
		const handler = (createMediaUploadUrlProcedure as any).handler;

		await expect(
			handler({
				input: {
					projectId: "proj-1",
					documentId: "doc-1",
					filename: "test.png",
					mimeType: "image/png",
					size: 1024,
				},
			}),
		).rejects.toThrow(/not found/i);
	});

	it("returns signed URL and S3 key on success", async () => {
		vi.mocked(getDocumentById).mockResolvedValueOnce({
			id: "doc-1",
			project: { id: "proj-1" },
		} as any);
		mockGetSignedUploadUrl.mockResolvedValueOnce(
			"https://s3.example.com/signed-upload",
		);

		const { createMediaUploadUrlProcedure } = await import(
			"../create-media-upload-url"
		);
		const handler = (createMediaUploadUrlProcedure as any).handler;

		const result = await handler({
			input: {
				projectId: "proj-1",
				documentId: "doc-1",
				filename: "photo.png",
				mimeType: "image/png",
				size: 2048,
			},
		});

		expect(result.signedUploadUrl).toBe(
			"https://s3.example.com/signed-upload",
		);
		expect(result.s3Key).toContain("document-media/proj-1/doc-1/");
		expect(result.s3Key).toMatch(/\.png$/);
		expect(result.useServerUpload).toBe(false);
		expect(result.storageProvider).toBe("s3");
	});

	it("generates correct extension for JPEG files", async () => {
		vi.mocked(getDocumentById).mockResolvedValueOnce({
			id: "doc-1",
			project: { id: "proj-1" },
		} as any);
		mockGetSignedUploadUrl.mockResolvedValueOnce("https://signed.url");

		const { createMediaUploadUrlProcedure } = await import(
			"../create-media-upload-url"
		);
		const handler = (createMediaUploadUrlProcedure as any).handler;

		const result = await handler({
			input: {
				projectId: "proj-1",
				documentId: "doc-1",
				filename: "photo.jpg",
				mimeType: "image/jpeg",
				size: 1024,
			},
		});

		expect(result.s3Key).toMatch(/\.jpg$/);
	});
});
