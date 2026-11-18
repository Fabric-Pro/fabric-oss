/**
 * The Proposal Inbox review note: one AGENT "AI Updates" Decision Log entry
 * per (proposal, item, outcome), skipped when the same key already exists.
 *
 * External boundaries mocked: Prisma client only.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	findFirst: vi.fn(),
	create: vi.fn(),
}));

vi.mock("../prisma/client", () => ({
	db: {
		decisionLogEntry: { findFirst: mocks.findFirst, create: mocks.create },
	},
	Prisma: {},
}));

vi.mock("../prisma/queries/feature-flags", () => ({
	isFeatureEnabled: vi.fn(),
}));

import { recordProposalReviewNote } from "../prisma/queries/projects/proposal-review-decision-note";

const params = {
	tenantFilter: { organizationId: "example-org", userId: "example-user" },
	userStoryId: "example-story",
	proposalId: "example-proposal",
	changeIndex: 2,
	outcome: "applied" as const,
	lines: ["Proposed update applied.", "  ", "Title: Renamed “A” → “B”"],
	authorName: "Example Reviewer",
};

beforeEach(() => {
	vi.clearAllMocks();
	mocks.findFirst.mockResolvedValue(null);
	mocks.create.mockResolvedValue({ id: "example-entry" });
});

describe("recordProposalReviewNote", () => {
	it("writes one keyed AI Updates entry", async () => {
		await expect(recordProposalReviewNote(params)).resolves.toEqual({
			written: true,
		});

		expect(mocks.findFirst).toHaveBeenCalledWith({
			where: {
				userStoryId: "example-story",
				impactedSection: "AI Updates",
				metadata: {
					path: ["proposalReviewNoteKey"],
					equals: "proposal:example-proposal:2:applied",
				},
			},
			select: { id: true },
		});
		expect(mocks.create).toHaveBeenCalledWith({
			data: expect.objectContaining({
				userStoryId: "example-story",
				authorType: "AGENT",
				authorName: "Example Reviewer",
				sourceProvenance: "Proposal review",
				status: "RESOLVED",
				source: "AI_CONFIRMED",
				impactedSection: "AI Updates",
				content: "Proposed update applied.\nTitle: Renamed “A” → “B”",
				organizationId: "example-org",
				userId: "example-user",
				metadata: {
					proposalReviewNoteKey:
						"proposal:example-proposal:2:applied",
					proposalId: "example-proposal",
					changeIndex: 2,
					outcome: "applied",
				},
			}),
		});
	});

	it("skips the write when the same note already exists (retry)", async () => {
		mocks.findFirst.mockResolvedValue({ id: "earlier-entry" });

		await expect(recordProposalReviewNote(params)).resolves.toEqual({
			written: false,
		});
		expect(mocks.create).not.toHaveBeenCalled();
	});

	it("writes nothing for an empty note", async () => {
		await expect(
			recordProposalReviewNote({ ...params, lines: ["", " "] }),
		).resolves.toEqual({ written: false });
		expect(mocks.findFirst).not.toHaveBeenCalled();
		expect(mocks.create).not.toHaveBeenCalled();
	});
});
