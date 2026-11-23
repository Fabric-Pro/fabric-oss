/**
 * The note a fully rejected update leaves: on the ticket the review ran on
 * when the request names one (an item re-routed in the inbox), otherwise on
 * the stored update's target; only when that is a ticket of the proposal's
 * own project, and never thrown.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	findStory: vi.fn(),
	recordNote: vi.fn(),
	warn: vi.fn(),
}));

vi.mock("@repo/database", async () => ({
	db: { userStory: { findFirst: mocks.findStory } },
	readStoredProposalChange: (
		await import(
			"../../../../../../database/prisma/queries/projects/proposal-changes"
		)
	).readStoredProposalChange,
	recordProposalReviewNote: mocks.recordNote,
}));

vi.mock("@repo/logs", () => ({
	logger: { warn: mocks.warn, info: vi.fn(), error: vi.fn() },
}));

import { noteRejectedProposalUpdate } from "../rejected-update-note";

const tenantFilter = { organizationId: "example-org", userId: "user-1" };

function proposalWith(change: Record<string, unknown>) {
	return {
		id: "prop-1",
		projectId: "project-1",
		proposal: { changes: [{ action: "create" }, change] },
	};
}

const updateItem = {
	action: "update",
	existingId: "story-1",
	reasoning: "Raised in the release thread",
};

beforeEach(() => {
	vi.clearAllMocks();
	mocks.findStory.mockResolvedValue({ id: "story-1" });
	mocks.recordNote.mockResolvedValue({ written: true });
});

describe("noteRejectedProposalUpdate", () => {
	it("notes a rejected update on its target in the same project", async () => {
		await noteRejectedProposalUpdate({
			proposal: proposalWith(updateItem),
			changeIndex: 1,
			tenantFilter,
			reviewerName: "Example Reviewer",
		});

		expect(mocks.findStory).toHaveBeenCalledWith({
			where: { id: "story-1", projectId: "project-1" },
			select: { id: true },
		});
		expect(mocks.recordNote).toHaveBeenCalledWith({
			tenantFilter,
			userStoryId: "story-1",
			proposalId: "prop-1",
			changeIndex: 1,
			outcome: "rejected",
			lines: [
				"Proposed update reviewed in the Proposal Inbox and fully rejected; no changes applied.",
				"Why: Raised in the release thread",
			],
			authorName: "Example Reviewer",
		});
	});

	it("skips a create item that was not reviewed on a ticket", async () => {
		await noteRejectedProposalUpdate({
			proposal: proposalWith(updateItem),
			changeIndex: 0,
			tenantFilter,
			reviewerName: null,
		});

		expect(mocks.findStory).not.toHaveBeenCalled();
		expect(mocks.recordNote).not.toHaveBeenCalled();
	});

	it("notes a create item re-routed to a ticket on the ticket the review ran on", async () => {
		mocks.findStory.mockResolvedValue({ id: "story-9" });

		await noteRejectedProposalUpdate({
			proposal: proposalWith(updateItem),
			changeIndex: 0,
			tenantFilter,
			reviewerName: "Example Reviewer",
			reviewedTicketId: "story-9",
		});

		// Still checked to be a ticket of the proposal's own project.
		expect(mocks.findStory).toHaveBeenCalledWith({
			where: { id: "story-9", projectId: "project-1" },
			select: { id: true },
		});
		expect(mocks.recordNote).toHaveBeenCalledWith(
			expect.objectContaining({
				userStoryId: "story-9",
				proposalId: "prop-1",
				changeIndex: 0,
				outcome: "rejected",
			}),
		);
	});

	it("notes an update re-routed to another ticket on the ticket the review ran on", async () => {
		mocks.findStory.mockResolvedValue({ id: "story-9" });

		await noteRejectedProposalUpdate({
			proposal: proposalWith(updateItem),
			changeIndex: 1,
			tenantFilter,
			reviewerName: null,
			reviewedTicketId: "story-9",
		});

		expect(mocks.findStory).toHaveBeenCalledWith({
			where: { id: "story-9", projectId: "project-1" },
			select: { id: true },
		});
		expect(mocks.recordNote).toHaveBeenCalledWith(
			expect.objectContaining({ userStoryId: "story-9" }),
		);
	});

	it("skips a target outside the proposal's project", async () => {
		mocks.findStory.mockResolvedValue(null);

		await noteRejectedProposalUpdate({
			proposal: proposalWith(updateItem),
			changeIndex: 1,
			tenantFilter,
			reviewerName: null,
		});

		expect(mocks.recordNote).not.toHaveBeenCalled();
	});

	it("logs instead of throwing when the note fails", async () => {
		mocks.recordNote.mockRejectedValue(new Error("db down"));

		await expect(
			noteRejectedProposalUpdate({
				proposal: proposalWith(updateItem),
				changeIndex: 1,
				tenantFilter,
				reviewerName: null,
			}),
		).resolves.toBeUndefined();
		expect(mocks.warn).toHaveBeenCalledOnce();
	});
});
