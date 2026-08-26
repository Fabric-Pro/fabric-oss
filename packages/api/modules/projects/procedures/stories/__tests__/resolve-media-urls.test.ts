/**
 * Tests for stories.resolveMediaUrlsProcedure
 *
 * Mirrors `documents/__tests__/resolve-media-urls.test.ts`. Verifies
 * authorization, S3 key prefix validation (`story-media/{projectId}/{storyId}/`),
 * and URL resolution via the storage provider.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", () => ({
	getStoryById: vi.fn(),
	hasProjectAccess: vi.fn(),
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

const mockGetSignedUrl = vi.fn();
vi.mock("@repo/storage", () => ({
	getStorageProvider: vi.fn(() => ({
		type: "s3",
		getSignedUrl: mockGetSignedUrl,
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
		resolveOrganizationId: vi.fn(
			(orgId: string | null | undefined) => orgId ?? null,
		),
		tenantProtectedProcedure: chain,
		Permissions: new Proxy({}, { get: (_t, p) => String(p) }),
		requirePermission: () => (c: unknown) => c,
		requireProjectPermission: () => (c: unknown) => c,
	};
});

import { getStoryById, hasProjectAccess } from "@repo/database";

describe("stories.resolveMediaUrls", () => {
	const mockContext = {
		user: { id: "user-1" },
		session: { id: "session-1", activeOrganizationId: null },
	};

	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("rejects when user lacks project access", async () => {
		vi.mocked(hasProjectAccess).mockResolvedValueOnce(false);

		const { resolveMediaUrlsProcedure } = await import(
			"../resolve-media-urls"
		);
		const handler = (resolveMediaUrlsProcedure as any).handler;

		await expect(
			handler({
				input: {
					projectId: "proj-1",
					userStoryId: "story-1",
					organizationId: null,
					s3Keys: ["story-media/proj-1/story-1/img.png"],
				},
				context: mockContext,
			}),
		).rejects.toThrow(/access/i);
	});

	it("rejects when story does not exist (or belongs to a different project)", async () => {
		vi.mocked(hasProjectAccess).mockResolvedValueOnce(true);
		vi.mocked(getStoryById).mockResolvedValueOnce(null);

		const { resolveMediaUrlsProcedure } = await import(
			"../resolve-media-urls"
		);
		const handler = (resolveMediaUrlsProcedure as any).handler;

		await expect(
			handler({
				input: {
					projectId: "proj-1",
					userStoryId: "story-1",
					organizationId: null,
					s3Keys: ["story-media/proj-1/story-1/img.png"],
				},
				context: mockContext,
			}),
		).rejects.toThrow(/not found/i);

		expect(getStoryById).toHaveBeenCalledWith("story-1", "proj-1");
	});

	it("rejects S3 keys that do not match the story prefix (cross-project)", async () => {
		vi.mocked(hasProjectAccess).mockResolvedValueOnce(true);
		vi.mocked(getStoryById).mockResolvedValueOnce({
			id: "story-1",
			projectId: "proj-1",
		} as any);

		const { resolveMediaUrlsProcedure } = await import(
			"../resolve-media-urls"
		);
		const handler = (resolveMediaUrlsProcedure as any).handler;

		await expect(
			handler({
				input: {
					projectId: "proj-1",
					userStoryId: "story-1",
					organizationId: null,
					s3Keys: ["story-media/OTHER-PROJ/story-1/img.png"],
				},
				context: mockContext,
			}),
		).rejects.toThrow(/do not belong/i);
	});

	it("rejects S3 keys that target a different story within the same project", async () => {
		vi.mocked(hasProjectAccess).mockResolvedValueOnce(true);
		vi.mocked(getStoryById).mockResolvedValueOnce({
			id: "story-1",
			projectId: "proj-1",
		} as any);

		const { resolveMediaUrlsProcedure } = await import(
			"../resolve-media-urls"
		);
		const handler = (resolveMediaUrlsProcedure as any).handler;

		await expect(
			handler({
				input: {
					projectId: "proj-1",
					userStoryId: "story-1",
					organizationId: null,
					s3Keys: ["story-media/proj-1/story-2/img.png"],
				},
				context: mockContext,
			}),
		).rejects.toThrow(/do not belong/i);
	});

	it("rejects document-media keys (wrong keyspace)", async () => {
		vi.mocked(hasProjectAccess).mockResolvedValueOnce(true);
		vi.mocked(getStoryById).mockResolvedValueOnce({
			id: "story-1",
			projectId: "proj-1",
		} as any);

		const { resolveMediaUrlsProcedure } = await import(
			"../resolve-media-urls"
		);
		const handler = (resolveMediaUrlsProcedure as any).handler;

		await expect(
			handler({
				input: {
					projectId: "proj-1",
					userStoryId: "story-1",
					organizationId: null,
					s3Keys: ["document-media/proj-1/story-1/img.png"],
				},
				context: mockContext,
			}),
		).rejects.toThrow(/do not belong/i);
	});

	it("resolves valid S3 keys to signed URLs", async () => {
		vi.mocked(hasProjectAccess).mockResolvedValueOnce(true);
		vi.mocked(getStoryById).mockResolvedValueOnce({
			id: "story-1",
			projectId: "proj-1",
		} as any);
		mockGetSignedUrl.mockResolvedValueOnce("https://signed.url/img.png");

		const { resolveMediaUrlsProcedure } = await import(
			"../resolve-media-urls"
		);
		const handler = (resolveMediaUrlsProcedure as any).handler;

		const result = await handler({
			input: {
				projectId: "proj-1",
				userStoryId: "story-1",
				organizationId: null,
				s3Keys: ["story-media/proj-1/story-1/abc.png"],
			},
			context: mockContext,
		});

		expect(result.urls).toEqual({
			"story-media/proj-1/story-1/abc.png": "https://signed.url/img.png",
		});
	});

	it("resolves multiple keys in parallel", async () => {
		vi.mocked(hasProjectAccess).mockResolvedValueOnce(true);
		vi.mocked(getStoryById).mockResolvedValueOnce({
			id: "story-1",
			projectId: "proj-1",
		} as any);
		mockGetSignedUrl
			.mockResolvedValueOnce("https://signed.url/a.png")
			.mockResolvedValueOnce("https://signed.url/b.jpg");

		const { resolveMediaUrlsProcedure } = await import(
			"../resolve-media-urls"
		);
		const handler = (resolveMediaUrlsProcedure as any).handler;

		const result = await handler({
			input: {
				projectId: "proj-1",
				userStoryId: "story-1",
				organizationId: null,
				s3Keys: [
					"story-media/proj-1/story-1/a.png",
					"story-media/proj-1/story-1/b.jpg",
				],
			},
			context: mockContext,
		});

		expect(Object.keys(result.urls)).toHaveLength(2);
	});

	it("skips keys that fail to resolve without throwing", async () => {
		vi.mocked(hasProjectAccess).mockResolvedValueOnce(true);
		vi.mocked(getStoryById).mockResolvedValueOnce({
			id: "story-1",
			projectId: "proj-1",
		} as any);
		mockGetSignedUrl
			.mockResolvedValueOnce("https://signed.url/good.png")
			.mockRejectedValueOnce(new Error("Not found"));

		const { resolveMediaUrlsProcedure } = await import(
			"../resolve-media-urls"
		);
		const handler = (resolveMediaUrlsProcedure as any).handler;

		const result = await handler({
			input: {
				projectId: "proj-1",
				userStoryId: "story-1",
				organizationId: null,
				s3Keys: [
					"story-media/proj-1/story-1/good.png",
					"story-media/proj-1/story-1/missing.png",
				],
			},
			context: mockContext,
		});

		expect(Object.keys(result.urls)).toHaveLength(1);
		expect(result.urls["story-media/proj-1/story-1/good.png"]).toBe(
			"https://signed.url/good.png",
		);
	});
});
