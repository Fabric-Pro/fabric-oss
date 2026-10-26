import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	claim: vi.fn(),
	create: vi.fn(),
	bind: vi.fn(),
	find: vi.fn(),
	entries: vi.fn(),
}));
vi.mock("../prisma/client", () => ({
	db: {
		pendingBacklogProposal: { updateMany: mocks.claim },
		$transaction: async (fn: (tx: unknown) => unknown) =>
			fn({
				pendingBacklogProposal: {
					updateMany: mocks.claim,
					update: mocks.bind,
					findUnique: mocks.find,
				},
				pendingBacklogProposalReview: { create: mocks.create },
				pendingBacklogProposalReviewEntry: {
					createMany: mocks.entries,
				},
			}),
	},
	Prisma: {},
}));

import {
	claimPendingProposalWithReview,
	returnFailedProposalToReview,
} from "../prisma/queries/projects/pending-backlog-proposals";

const input = {
	proposalId: "example-proposal",
	reviewedBy: "example-user",
	applyWorkflowId: "example-attempt",
	syncToPM: false,
	offeredListComplete: true,
	entries: [
		{
			offeredIndex: 0,
			changeIndex: 0,
			selected: true,
			change: { title: { to: "Edited" } },
		},
		{ offeredIndex: 1, changeIndex: 1, selected: false },
	],
};
beforeEach(() => {
	vi.resetAllMocks();
	mocks.claim.mockResolvedValue({ count: 1 });
	mocks.create.mockResolvedValue({ id: "example-review" });
	mocks.find.mockResolvedValue(null);
});
describe("atomic proposal claim and review", () => {
	it("losing claim writes no review or binding", async () => {
		mocks.claim.mockResolvedValue({ count: 0 });
		expect(await claimPendingProposalWithReview(input)).toBe(false);
		expect(mocks.create).not.toHaveBeenCalled();
		expect(mocks.entries).not.toHaveBeenCalled();
		expect(mocks.bind).not.toHaveBeenCalled();
	});
	it("winning claim writes entries and binds the review to the attempt", async () => {
		expect(await claimPendingProposalWithReview(input)).toBe(true);
		expect(mocks.create).toHaveBeenCalledWith({
			data: expect.objectContaining({
				proposalId: input.proposalId,
				offeredCount: 2,
				selectedCount: 1,
				syncToPM: false,
				offeredListComplete: true,
			}),
		});
		expect(mocks.entries).toHaveBeenCalledTimes(1);
		expect(mocks.entries).toHaveBeenCalledWith({
			data: input.entries.map((e) => ({
				...e,
				proposalId: input.proposalId,
				reviewId: "example-review",
			})),
		});
		expect(mocks.bind).toHaveBeenCalledWith({
			where: { id: input.proposalId },
			data: {
				applyReviewId: "example-review",
				applyReviewWorkflowId: input.applyWorkflowId,
			},
		});
	});
	it("same keyed attempt reuses its review after winning the reentrant claim", async () => {
		mocks.find.mockResolvedValue({
			applyReviewId: "example-review",
			applyReviewWorkflowId: input.applyWorkflowId,
		});
		expect(
			await claimPendingProposalWithReview({
				...input,
				reuseReviewForAttempt: true,
			}),
		).toBe(true);
		expect(mocks.create).not.toHaveBeenCalled();
		expect(mocks.entries).not.toHaveBeenCalled();
	});
	it("a new submission writes a new review even if the timestamp attempt id repeats", async () => {
		mocks.find.mockResolvedValue({
			applyReviewId: "example-old-review",
			applyReviewWorkflowId: input.applyWorkflowId,
		});
		expect(await claimPendingProposalWithReview(input)).toBe(true);
		expect(mocks.create).toHaveBeenCalledTimes(1);
	});
	it("returning to review fences the read attempt and clears bindings", async () => {
		const expected = {
			applyWorkflowId: "example-old-attempt",
			applyReviewId: "example-old-review",
		};
		mocks.claim.mockResolvedValue({ count: 0 });
		expect(
			await returnFailedProposalToReview(input.proposalId, expected),
		).toBe(false);
		expect(mocks.claim).toHaveBeenCalledWith({
			where: { id: input.proposalId, status: "FAILED", ...expected },
			data: expect.objectContaining({
				status: "PENDING",
				applyWorkflowId: null,
				applyReviewId: null,
				applyReviewWorkflowId: null,
				applyError: null,
				errorClass: null,
				errorMessage: null,
				failedAt: null,
			}),
		});
	});
});
