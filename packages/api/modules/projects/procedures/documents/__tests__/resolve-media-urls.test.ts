/**
 * Tests for resolveMediaUrlsProcedure
 *
 * Verifies authorization, S3 key prefix validation, and URL resolution.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", () => ({
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

import { hasProjectAccess } from "@repo/database";

describe("resolveMediaUrls", () => {
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
					documentId: "doc-1",
					organizationId: null,
					s3Keys: ["document-media/proj-1/doc-1/img.png"],
				},
				context: mockContext,
			}),
		).rejects.toThrow(/access/i);
	});

	it("rejects S3 keys that do not match the document prefix", async () => {
		vi.mocked(hasProjectAccess).mockResolvedValueOnce(true);

		const { resolveMediaUrlsProcedure } = await import(
			"../resolve-media-urls"
		);
		const handler = (resolveMediaUrlsProcedure as any).handler;

		await expect(
			handler({
				input: {
					projectId: "proj-1",
					documentId: "doc-1",
					organizationId: null,
					s3Keys: ["document-media/OTHER-PROJ/doc-1/img.png"],
				},
				context: mockContext,
			}),
		).rejects.toThrow(/do not belong/i);
	});

	it("resolves valid S3 keys to signed URLs", async () => {
		vi.mocked(hasProjectAccess).mockResolvedValueOnce(true);
		mockGetSignedUrl.mockResolvedValueOnce("https://signed.url/img.png");

		const { resolveMediaUrlsProcedure } = await import(
			"../resolve-media-urls"
		);
		const handler = (resolveMediaUrlsProcedure as any).handler;

		const result = await handler({
			input: {
				projectId: "proj-1",
				documentId: "doc-1",
				organizationId: null,
				s3Keys: ["document-media/proj-1/doc-1/abc.png"],
			},
			context: mockContext,
		});

		expect(result.urls).toEqual({
			"document-media/proj-1/doc-1/abc.png": "https://signed.url/img.png",
		});
	});

	it("resolves multiple keys in parallel", async () => {
		vi.mocked(hasProjectAccess).mockResolvedValueOnce(true);
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
				documentId: "doc-1",
				organizationId: null,
				s3Keys: [
					"document-media/proj-1/doc-1/a.png",
					"document-media/proj-1/doc-1/b.jpg",
				],
			},
			context: mockContext,
		});

		expect(Object.keys(result.urls)).toHaveLength(2);
	});

	it("skips keys that fail to resolve without throwing", async () => {
		vi.mocked(hasProjectAccess).mockResolvedValueOnce(true);
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
				documentId: "doc-1",
				organizationId: null,
				s3Keys: [
					"document-media/proj-1/doc-1/good.png",
					"document-media/proj-1/doc-1/missing.png",
				],
			},
			context: mockContext,
		});

		expect(Object.keys(result.urls)).toHaveLength(1);
		expect(result.urls["document-media/proj-1/doc-1/good.png"]).toBe(
			"https://signed.url/good.png",
		);
	});
});
