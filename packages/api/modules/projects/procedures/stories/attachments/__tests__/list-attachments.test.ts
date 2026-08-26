import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", () => ({
	db: {
		userStory: { findFirst: vi.fn() },
		storyAttachment: { findMany: vi.fn() },
	},
}));
vi.mock("@repo/config", () => ({
	config: {
		storage: { bucketNames: { projectContexts: "project-contexts" } },
	},
}));
vi.mock("@repo/storage", () => ({ getStorageProvider: vi.fn() }));
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
import { listAttachmentsProcedure } from "../list-attachments";

const handler = (listAttachmentsProcedure as unknown as { handler: Function })
	.handler;
const ctx = { user: { id: "u1" }, session: {} };
const input = { projectId: "p1", userStoryId: "s1" };
const row = {
	id: "a1",
	filename: "spec.pdf",
	mimeType: "application/pdf",
	sizeBytes: 10,
	designation: "LOCKED",
	source: "PM_SYNCED",
	sourceTool: "jira",
	promotedAt: null,
	externalAuthor: "QA Engineer",
	externalCreatedAt: new Date(1),
	createdAt: new Date(0),
	storageKey: "story-attachments/p1/s1/abc.pdf",
};

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(db.userStory.findFirst).mockResolvedValue({ id: "s1" } as never);
	vi.mocked(db.storyAttachment.findMany).mockResolvedValue([row] as never);
});

describe("listAttachments", () => {
	it("is gated on STORY_READ", () => {
		expect(
			(listAttachmentsProcedure as unknown as { __permission: string })
				.__permission,
		).toBe("story:read");
	});

	it("never asks the database for the extracted attachment text (AE5/R14)", async () => {
		// The column holds document text, cached for the AI-context resolver.
		// This payload serves the browser panel, so the text must not be in the
		// select at all — not fetched and then stripped.
		vi.mocked(getStorageProvider).mockReturnValue({
			getSignedUrl: vi.fn().mockResolvedValue("https://dl.example/a1"),
		} as never);

		await handler({ input, context: ctx });

		const args = vi.mocked(db.storyAttachment.findMany).mock
			.calls[0]?.[0] as {
			select?: Record<string, unknown>;
		};
		expect(args.select).toBeDefined();
		expect(args.select).not.toHaveProperty("extractedText");
	});

	it("does not surface extracted text even if a row carries it", async () => {
		// Defence in depth against the select guard above being widened: the
		// response shape itself should never carry the column.
		vi.mocked(db.storyAttachment.findMany).mockResolvedValue([
			{ ...row, extractedText: "SECRET DOCUMENT BODY" },
		] as never);
		vi.mocked(getStorageProvider).mockReturnValue({
			getSignedUrl: vi.fn().mockResolvedValue("https://dl.example/a1"),
		} as never);

		const res = await handler({ input, context: ctx });

		expect(JSON.stringify(res)).not.toContain("SECRET DOCUMENT BODY");
	});

	it("returns rows with a signed downloadUrl (Content-Disposition passed)", async () => {
		const getSignedUrl = vi.fn().mockResolvedValue("https://dl.example/a1");
		vi.mocked(getStorageProvider).mockReturnValue({
			getSignedUrl,
		} as never);
		const res = await handler({ input, context: ctx });
		expect(res.attachments[0].downloadUrl).toBe("https://dl.example/a1");
		expect(res.attachments[0].storageKey).toBeUndefined(); // storageKey not leaked to client
		expect(getSignedUrl).toHaveBeenCalledWith(
			"story-attachments/p1/s1/abc.pdf",
			expect.objectContaining({
				responseContentDisposition: expect.stringContaining(
					'filename="spec.pdf"',
				),
			}),
		);
	});

	it("emits downloadUrl=null when signing fails (orphan tolerance)", async () => {
		vi.mocked(getStorageProvider).mockReturnValue({
			getSignedUrl: vi.fn().mockRejectedValue(new Error("gone")),
		} as never);
		const res = await handler({ input, context: ctx });
		expect(res.attachments[0].downloadUrl).toBeNull();
	});

	it("excludes soft-deleted rows from the list", async () => {
		vi.mocked(getStorageProvider).mockReturnValue({
			getSignedUrl: vi.fn().mockResolvedValue("https://dl.example/a1"),
		} as never);
		await handler({ input, context: ctx });
		expect(vi.mocked(db.storyAttachment.findMany)).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { storyId: "s1", deletedAt: null },
			}),
		);
	});
});

describe("provenance projection (Fizzy #1746)", () => {
	it("returns source, tool, promotion and PM metadata", async () => {
		vi.mocked(getStorageProvider).mockReturnValue({
			getSignedUrl: vi.fn().mockResolvedValue("https://signed"),
		} as never);

		const { attachments } = await handler({ input, context: ctx });

		expect(attachments[0]).toMatchObject({
			source: "PM_SYNCED",
			sourceTool: "jira",
			promotedAt: null,
			externalAuthor: "QA Engineer",
			externalCreatedAt: new Date(1),
		});
	});

	it("never leaks storageKey, extractedText, or contentHash", async () => {
		vi.mocked(getStorageProvider).mockReturnValue({
			getSignedUrl: vi.fn().mockResolvedValue("https://signed"),
		} as never);

		const { attachments } = await handler({ input, context: ctx });

		expect(attachments[0]).not.toHaveProperty("storageKey");
		expect(attachments[0]).not.toHaveProperty("extractedText");
		expect(attachments[0]).not.toHaveProperty("contentHash");
	});

	it("selects the new columns from the database", async () => {
		vi.mocked(getStorageProvider).mockReturnValue({
			getSignedUrl: vi.fn().mockResolvedValue("https://signed"),
		} as never);

		await handler({ input, context: ctx });

		const select = vi.mocked(db.storyAttachment.findMany).mock.calls[0][0]
			.select;
		expect(select).toMatchObject({
			source: true,
			sourceTool: true,
			promotedAt: true,
			externalAuthor: true,
			externalCreatedAt: true,
		});
		expect(select).not.toHaveProperty("extractedText");
		expect(select).not.toHaveProperty("contentHash");
	});
});
