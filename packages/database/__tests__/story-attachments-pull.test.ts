/**
 * Persistence for the PM pull half (Fizzy #1745, AC-5/AC-7/AC-8/AC-9).
 *
 * `StoryAttachmentSyncIssue` gets its first writer here — the model has been
 * in the schema since #1702 with nothing reading or writing it.
 *
 * Run with: pnpm --filter @repo/database test __tests__/story-attachments-pull.test.ts
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { createAttachment, createIssue, uploadFile, storyFindFirst } =
	vi.hoisted(() => ({
		createAttachment: vi.fn(),
		createIssue: vi.fn(),
		uploadFile: vi.fn(),
		storyFindFirst: vi.fn(),
	}));

vi.mock("../prisma/client", () => ({
	db: {
		storyAttachment: { create: createAttachment },
		storyAttachmentSyncIssue: { create: createIssue },
		userStory: { findFirst: storyFindFirst },
	},
}));

vi.mock("@repo/storage", () => ({ uploadFile }));

vi.mock("@repo/config", () => ({
	config: { storage: { bucketNames: { projectContexts: "ctx-bucket" } } },
}));

import {
	importPulledStoryAttachment,
	recordStoryAttachmentSyncIssue,
} from "../prisma/queries/projects/story-attachments";

const importArgs = {
	storyId: "story-1",
	projectId: "proj-1",
	filename: "spec.pdf",
	mimeType: "application/pdf",
	data: Buffer.from([1, 2, 3]),
	contentHash: "hash-1",
	externalAttachmentId: "/uploads/abc/spec.pdf",
};

beforeEach(() => {
	vi.clearAllMocks();
	storyFindFirst.mockResolvedValue({ id: "story-1" });
	uploadFile.mockResolvedValue(undefined);
	createAttachment.mockResolvedValue({ id: "att-new" });
	createIssue.mockResolvedValue({ id: "issue-new" });
});

describe("importPulledStoryAttachment (AC-5)", () => {
	it("writes the bytes under the story's own final prefix before creating the row", async () => {
		await importPulledStoryAttachment(importArgs);
		const [key, data, options] = uploadFile.mock.calls[0] ?? [];
		// Same prefix scheme as create-attachment.ts's finalKey, so the
		// retention purge and the tenant-path rules apply unchanged.
		expect(String(key)).toMatch(/^story-attachments\/proj-1\/story-1\//);
		expect(data).toBe(importArgs.data);
		expect(options).toMatchObject({
			bucket: "ctx-bucket",
			contentType: "application/pdf",
		});
	});

	it("records the PM handle and the content hash so the next pull can dedupe", async () => {
		await importPulledStoryAttachment(importArgs);
		expect(createAttachment).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					storyId: "story-1",
					filename: "spec.pdf",
					sizeBytes: 3,
					contentHash: "hash-1",
					externalAttachmentId: "/uploads/abc/spec.pdf",
					designation: "UNLOCKED",
					source: "PM_SYNCED",
				}),
			}),
		);
	});

	// Tenancy: a stale or forged storyId must not be able to write an
	// attachment into another tenant's story. Mirrors the `story: { projectId }`
	// scoping getStoryAttachmentsForSync already uses on the read side.
	it("refuses to write when the story does not belong to the project", async () => {
		storyFindFirst.mockResolvedValue(null);
		await expect(importPulledStoryAttachment(importArgs)).rejects.toThrow(
			/not found|does not belong/i,
		);
		expect(uploadFile).not.toHaveBeenCalled();
		expect(createAttachment).not.toHaveBeenCalled();
	});

	// Storage is not transactional with the database. Writing the row first
	// would leave a row pointing at bytes that never arrived; this order at
	// worst leaves an orphaned object, which the retention sweep collects.
	it("does not create the row when the upload fails", async () => {
		uploadFile.mockRejectedValue(new Error("R2 down"));
		await expect(importPulledStoryAttachment(importArgs)).rejects.toThrow(
			/R2 down/,
		);
		expect(createAttachment).not.toHaveBeenCalled();
	});
});

describe("recordStoryAttachmentSyncIssue (AC-7/AC-8/AC-9)", () => {
	it("writes the issue row with its machine-readable reason", async () => {
		await recordStoryAttachmentSyncIssue({
			storyId: "story-1",
			sourceTool: "gitlab",
			filename: "big.pdf",
			reason: "TOO_LARGE",
		});
		expect(createIssue).toHaveBeenCalledWith({
			data: {
				storyId: "story-1",
				sourceTool: "gitlab",
				filename: "big.pdf",
				reason: "TOO_LARGE",
			},
		});
	});

	// A sync issue is a REPORT about a pull, never the point of it. Letting a
	// write failure here escape would turn "we noticed a discrepancy" into
	// "the pull failed" — the exact inversion AC-4 forbids on the push side.
	it("never throws when the write fails", async () => {
		createIssue.mockRejectedValue(new Error("db down"));
		await expect(
			recordStoryAttachmentSyncIssue({
				storyId: "story-1",
				sourceTool: "gitlab",
				filename: "x.pdf",
				reason: "CONFLICT",
			}),
		).resolves.toBeUndefined();
	});
});
