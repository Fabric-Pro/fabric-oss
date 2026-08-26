import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", () => ({
	db: { userStory: { findFirst: vi.fn() } },
}));
vi.mock("@repo/config", () => ({
	config: {
		storage: { bucketNames: { projectContexts: "project-contexts" } },
	},
}));
vi.mock("@repo/storage", () => ({ getStorageProvider: vi.fn() }));
// H1: capture __permission so we can assert the gate in a separate test
vi.mock("../../../../../../orpc/procedures", () => {
	const chain: Record<string, unknown> = {};
	for (const m of ["use", "route", "input", "output"]) {
		chain[m] = () => chain;
	}
	chain.handler = (fn: unknown) => ({
		handler: fn,
		__permission: chain.__permission,
	});
	return {
		tenantProtectedProcedure: chain,
		requireProjectPermission: (p: string) => {
			chain.__permission = p;
			return () => chain;
		},
		Permissions: { STORY_UPDATE: "story:update", STORY_READ: "story:read" },
	};
});

import { db } from "@repo/database";
import { getStorageProvider } from "@repo/storage";
import { createAttachmentUploadUrlProcedure } from "../create-attachment-upload-url";

const handler = (
	createAttachmentUploadUrlProcedure as unknown as { handler: Function }
).handler;
const ctx = { user: { id: "u1" }, session: {} };
const validInput = {
	projectId: "p1",
	userStoryId: "s1",
	filename: "spec.pdf",
	mimeType: "application/pdf",
	size: 1234,
};

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(db.userStory.findFirst).mockResolvedValue({ id: "s1" } as never);
	vi.mocked(getStorageProvider).mockReturnValue({
		type: "s3",
		supportsPresignedUrls: true,
		getSignedDocumentUploadUrl: vi
			.fn()
			.mockResolvedValue("https://signed.example/put"),
	} as never);
});

describe("createAttachmentUploadUrl", () => {
	// H1: permission gate assertion
	it("is gated on STORY_UPDATE", () => {
		expect(
			(
				createAttachmentUploadUrlProcedure as unknown as {
					__permission: string;
				}
			).__permission,
		).toBe("story:update");
	});

	it("rejects a non-allowlisted mime", async () => {
		// #1778: resolveAttachmentMime falls back to the filename extension, so a
		// disallowed browser mime must be paired with a disallowed extension too
		// (otherwise the extension-rescue path — the intended #1778 behavior —
		// would legitimately accept the upload).
		await expect(
			handler({
				input: {
					...validInput,
					filename: "evil.exe",
					mimeType: "application/x-msdownload",
				},
				context: ctx,
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
	});

	it("rejects an oversize file", async () => {
		await expect(
			handler({
				input: { ...validInput, size: 26 * 1024 * 1024 },
				context: ctx,
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
	});

	it("throws NOT_FOUND when the story is not in the project", async () => {
		vi.mocked(db.userStory.findFirst).mockResolvedValue(null);
		await expect(
			handler({ input: validInput, context: ctx }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
	});

	it("mints a presigned PUT under the story-attachments-tmp prefix (never the final key)", async () => {
		const provider = {
			type: "s3",
			supportsPresignedUrls: true,
			getSignedDocumentUploadUrl: vi
				.fn()
				.mockResolvedValue("https://signed.example/put"),
		};
		vi.mocked(getStorageProvider).mockReturnValue(provider as never);

		const res = await handler({ input: validInput, context: ctx });

		expect(res.storageKey).toMatch(
			/^story-attachments-tmp\/p1\/s1\/[0-9a-f-]+\.pdf$/,
		);
		expect(res.storageKey.startsWith("story-attachments/")).toBe(false);
		expect(res.signedUploadUrl).toBe("https://signed.example/put");
		// The presign targets the temp key, not the final key (the #1 invariant).
		expect(provider.getSignedDocumentUploadUrl).toHaveBeenCalledWith(
			expect.stringMatching(/^story-attachments-tmp\//),
			expect.objectContaining({
				bucket: "project-contexts",
				contentLength: 1234,
			}),
		);
	});

	// H2: no-presigned-provider branch
	it("throws SERVICE_UNAVAILABLE when the provider lacks presigned support", async () => {
		vi.mocked(getStorageProvider).mockReturnValue({
			type: "minio",
			supportsPresignedUrls: false,
			getSignedDocumentUploadUrl: null,
		} as never);
		await expect(
			handler({ input: validInput, context: ctx }),
		).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
	});

	// #1778: server-side MIME resolution
	it("accepts a .md upload whose browser mime is empty and returns text/markdown contentType", async () => {
		const provider = {
			type: "s3",
			supportsPresignedUrls: true,
			getSignedDocumentUploadUrl: vi
				.fn()
				.mockResolvedValue("https://signed.example/put"),
		};
		vi.mocked(getStorageProvider).mockReturnValue(provider as never);

		const res = await handler({
			input: {
				projectId: "p1",
				userStoryId: "s1",
				organizationId: null,
				filename: "notes.md",
				mimeType: "",
				size: 10,
			},
			context: ctx,
		});

		expect(res.contentType).toBe("text/markdown");
		expect(res.storageKey).toMatch(/\.md$/);
		expect(provider.getSignedDocumentUploadUrl).toHaveBeenCalledWith(
			expect.any(String),
			expect.objectContaining({ contentType: "text/markdown" }),
		);
	});

	it("rejects an unsupported type", async () => {
		await expect(
			handler({
				input: {
					projectId: "p1",
					userStoryId: "s1",
					organizationId: null,
					filename: "evil.exe",
					mimeType: "application/x-msdownload",
					size: 10,
				},
				context: ctx,
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
	});
});
