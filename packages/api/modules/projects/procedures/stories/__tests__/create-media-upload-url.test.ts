/**
 * Tests for stories.createMediaUploadUrlProcedure
 *
 * Mirrors `documents/__tests__/create-media-upload-url.test.ts`. Verifies
 * MIME type validation, story-belongs-to-project membership check, and
 * signed URL generation. Authorization (`Permissions.STORY_UPDATE`) is
 * enforced by the `requireProjectPermission` middleware (covered by
 * permission-coverage + roles regression tests) — these handler-level tests
 * stub the middleware out and focus on behavior.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", () => ({
	getStoryById: vi.fn(),
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

import { getStoryById } from "@repo/database";

describe("stories.createMediaUploadUrl", () => {
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
					userStoryId: "story-1",
					filename: "test.svg",
					mimeType: "image/svg+xml",
					size: 1024,
				},
			}),
		).rejects.toThrow(/unsupported image type/i);
	});

	it("rejects HEIC images (not in PNG/JPEG/GIF/WebP allowlist)", async () => {
		const { createMediaUploadUrlProcedure } = await import(
			"../create-media-upload-url"
		);
		const handler = (createMediaUploadUrlProcedure as any).handler;

		await expect(
			handler({
				input: {
					projectId: "proj-1",
					userStoryId: "story-1",
					filename: "photo.heic",
					mimeType: "image/heic",
					size: 1024,
				},
			}),
		).rejects.toThrow(/unsupported image type/i);
	});

	it("rejects when story does not exist (or belongs to a different project)", async () => {
		// getStoryById filters by both id AND projectId — so a story not in this
		// project resolves to null. This validates the XOR tenant gate.
		vi.mocked(getStoryById).mockResolvedValueOnce(null);

		const { createMediaUploadUrlProcedure } = await import(
			"../create-media-upload-url"
		);
		const handler = (createMediaUploadUrlProcedure as any).handler;

		await expect(
			handler({
				input: {
					projectId: "proj-1",
					userStoryId: "story-1",
					filename: "test.png",
					mimeType: "image/png",
					size: 1024,
				},
			}),
		).rejects.toThrow(/not found/i);

		expect(getStoryById).toHaveBeenCalledWith("story-1", "proj-1");
	});

	it("returns signed URL and S3 key on success with story-media prefix", async () => {
		vi.mocked(getStoryById).mockResolvedValueOnce({
			id: "story-1",
			projectId: "proj-1",
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
				userStoryId: "story-1",
				filename: "photo.png",
				mimeType: "image/png",
				size: 2048,
			},
		});

		expect(result.signedUploadUrl).toBe(
			"https://s3.example.com/signed-upload",
		);
		expect(result.s3Key).toContain("story-media/proj-1/story-1/");
		expect(result.s3Key).toMatch(/\.png$/);
		expect(result.useServerUpload).toBe(false);
		expect(result.storageProvider).toBe("s3");

		// Bucket = same as documents (`projectContexts`).
		expect(mockGetSignedUploadUrl).toHaveBeenCalledWith(
			expect.stringContaining("story-media/proj-1/story-1/"),
			expect.objectContaining({
				bucket: "test-bucket",
				contentType: "image/png",
			}),
		);
	});

	it("generates correct extension for JPEG files", async () => {
		vi.mocked(getStoryById).mockResolvedValueOnce({
			id: "story-1",
			projectId: "proj-1",
		} as any);
		mockGetSignedUploadUrl.mockResolvedValueOnce("https://signed.url");

		const { createMediaUploadUrlProcedure } = await import(
			"../create-media-upload-url"
		);
		const handler = (createMediaUploadUrlProcedure as any).handler;

		const result = await handler({
			input: {
				projectId: "proj-1",
				userStoryId: "story-1",
				filename: "photo.jpg",
				mimeType: "image/jpeg",
				size: 1024,
			},
		});

		expect(result.s3Key).toMatch(/\.jpg$/);
	});

	it("generates correct extension for GIF and WebP", async () => {
		const { createMediaUploadUrlProcedure } = await import(
			"../create-media-upload-url"
		);
		const handler = (createMediaUploadUrlProcedure as any).handler;

		// GIF
		vi.mocked(getStoryById).mockResolvedValueOnce({
			id: "story-1",
			projectId: "proj-1",
		} as any);
		mockGetSignedUploadUrl.mockResolvedValueOnce("https://signed.url/gif");
		const gif = await handler({
			input: {
				projectId: "proj-1",
				userStoryId: "story-1",
				filename: "anim.gif",
				mimeType: "image/gif",
				size: 1024,
			},
		});
		expect(gif.s3Key).toMatch(/\.gif$/);

		// WebP
		vi.mocked(getStoryById).mockResolvedValueOnce({
			id: "story-1",
			projectId: "proj-1",
		} as any);
		mockGetSignedUploadUrl.mockResolvedValueOnce("https://signed.url/webp");
		const webp = await handler({
			input: {
				projectId: "proj-1",
				userStoryId: "story-1",
				filename: "img.webp",
				mimeType: "image/webp",
				size: 1024,
			},
		});
		expect(webp.s3Key).toMatch(/\.webp$/);
	});

	it("returns useServerUpload=true when storage provider lacks presigned support", async () => {
		const { getStorageProvider } = await import("@repo/storage");
		vi.mocked(getStorageProvider).mockReturnValueOnce({
			type: "local",
			supportsPresignedUrls: false,
		} as any);
		vi.mocked(getStoryById).mockResolvedValueOnce({
			id: "story-1",
			projectId: "proj-1",
		} as any);

		const { createMediaUploadUrlProcedure } = await import(
			"../create-media-upload-url"
		);
		const handler = (createMediaUploadUrlProcedure as any).handler;

		const result = await handler({
			input: {
				projectId: "proj-1",
				userStoryId: "story-1",
				filename: "photo.png",
				mimeType: "image/png",
				size: 1024,
			},
		});

		expect(result.signedUploadUrl).toBeNull();
		expect(result.useServerUpload).toBe(true);
		expect(result.storageProvider).toBe("local");
	});
});
