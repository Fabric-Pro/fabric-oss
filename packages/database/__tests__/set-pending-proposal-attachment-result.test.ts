/**
 * Unit tests for `setPendingProposalAttachmentResult`.
 *
 * Behaviour spec (`fabric/specs/2026-05-23-chat-thread-image-attachments/spec.md` § 4.6 step 8, FR-22, FR-23, § 10.3):
 *   1. Merge does NOT drop other `sourceMetadata` keys
 *      (`channelDisplayName`, `threadRootId`, etc. preserved).
 *   2. Rerun with empty `warnings` AND no existing warnings is a no-op
 *      — the row is read but NOT written.
 *   3. Rerun with overlapping warnings dedups by `{ source, refId, reason }`.
 *
 * External boundaries mocked: Prisma client only.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { mocks } = vi.hoisted(() => ({
	mocks: {
		findUnique: vi.fn(),
		update: vi.fn(),
	},
}));

vi.mock("../prisma/client", () => ({
	db: {
		pendingBacklogProposal: {
			findUnique: mocks.findUnique,
			update: mocks.update,
		},
	},
	Prisma: { DbNull: { __dbNull: true } },
}));

import { setPendingProposalAttachmentResult } from "../prisma/queries/projects/pending-backlog-proposals";

describe("setPendingProposalAttachmentResult", () => {
	beforeEach(() => {
		mocks.findUnique.mockReset();
		mocks.update.mockReset();
		mocks.update.mockResolvedValue({});
	});

	it("preserves every other sourceMetadata key while merging warnings", async () => {
		mocks.findUnique.mockResolvedValue({
			sourceMetadata: {
				channelDisplayName: "general",
				channelWebUrl: "https://example.slack.com/c1",
				threadRootId: "1690000000.123",
				slackTeamId: "T123",
				transcript: "Hi team",
				attachments: [
					{
						source: "slack",
						file: {
							id: "F1",
							name: "a.png",
							mimetype: "image/png",
						},
						messageTs: "1690000000.123",
					},
				],
				// No existing attachmentWarnings.
			},
		});

		await setPendingProposalAttachmentResult("proposal-1", [
			{ source: "slack", refId: "F2", reason: "upload_failed" },
		]);

		expect(mocks.update).toHaveBeenCalledOnce();
		const firstCall = mocks.update.mock.calls[0] as [
			{
				where: { id: string };
				data: { sourceMetadata: Record<string, unknown> };
			},
		];
		const args = firstCall[0];
		expect(args.where.id).toBe("proposal-1");
		const merged = args.data.sourceMetadata;
		// Every other key preserved verbatim.
		expect(merged.channelDisplayName).toBe("general");
		expect(merged.channelWebUrl).toBe("https://example.slack.com/c1");
		expect(merged.threadRootId).toBe("1690000000.123");
		expect(merged.slackTeamId).toBe("T123");
		expect(merged.transcript).toBe("Hi team");
		expect(merged.attachments).toEqual([
			{
				source: "slack",
				file: { id: "F1", name: "a.png", mimetype: "image/png" },
				messageTs: "1690000000.123",
			},
		]);
		// The new warning was appended.
		expect(merged.attachmentWarnings).toEqual([
			{ source: "slack", refId: "F2", reason: "upload_failed" },
		]);
	});

	it("is a no-op when both inputs and existing warnings are empty", async () => {
		mocks.findUnique.mockResolvedValue({
			sourceMetadata: {
				channelDisplayName: "general",
				// no attachmentWarnings — fresh proposal.
			},
		});
		await setPendingProposalAttachmentResult("proposal-2", []);
		// Row was read (to learn that warnings list is empty).
		expect(mocks.findUnique).toHaveBeenCalledOnce();
		// No write was performed because there is nothing to merge.
		expect(mocks.update).not.toHaveBeenCalled();
	});

	it("dedups by { source, refId, reason } across existing + new warnings", async () => {
		mocks.findUnique.mockResolvedValue({
			sourceMetadata: {
				channelDisplayName: "qa-bugs",
				attachmentWarnings: [
					{ source: "slack", refId: "F1", reason: "upload_failed" },
					{ source: "slack", refId: "F2", reason: "scope_missing" },
				],
			},
		});
		await setPendingProposalAttachmentResult("proposal-3", [
			// Exact duplicate of existing[0] — must NOT produce a second copy.
			{ source: "slack", refId: "F1", reason: "upload_failed" },
			// New, non-overlapping entry — must be appended.
			{ source: "slack", refId: "F3", reason: "external_workspace" },
			// Same refId as existing[1] but different reason — distinct tuple,
			// must be appended.
			{ source: "slack", refId: "F2", reason: "upload_failed" },
		]);

		expect(mocks.update).toHaveBeenCalledOnce();
		const args = mocks.update.mock.calls[0]?.[0] as {
			data: {
				sourceMetadata: { attachmentWarnings: unknown[] };
			};
		};
		const stored = args.data.sourceMetadata.attachmentWarnings;
		expect(stored).toEqual([
			// Existing (preserved + order-stable).
			{ source: "slack", refId: "F1", reason: "upload_failed" },
			{ source: "slack", refId: "F2", reason: "scope_missing" },
			// New, non-dup additions appended in input order.
			{ source: "slack", refId: "F3", reason: "external_workspace" },
			{ source: "slack", refId: "F2", reason: "upload_failed" },
		]);
	});

	it("merges into an empty sourceMetadata object when the existing row has none", async () => {
		mocks.findUnique.mockResolvedValue({ sourceMetadata: null });

		await setPendingProposalAttachmentResult("proposal-4", [
			{ source: "teams", refId: "HC1", reason: "download_failed" },
		]);

		expect(mocks.update).toHaveBeenCalledOnce();
		const args = mocks.update.mock.calls[0]?.[0] as {
			data: {
				sourceMetadata: {
					attachmentWarnings: unknown[];
				};
			};
		};
		expect(args.data.sourceMetadata.attachmentWarnings).toEqual([
			{ source: "teams", refId: "HC1", reason: "download_failed" },
		]);
	});

	it("returns silently when the proposal row does not exist", async () => {
		mocks.findUnique.mockResolvedValue(null);
		await setPendingProposalAttachmentResult("proposal-missing", [
			{ source: "slack", refId: "F1", reason: "upload_failed" },
		]);
		expect(mocks.update).not.toHaveBeenCalled();
	});
});
