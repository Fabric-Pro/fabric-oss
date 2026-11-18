/**
 * Per-item proposal state: the resolved-set rule shared by every apply path
 * (applied ∪ application rows ∪ duplicate resolutions ∪ items moved to
 * Rejected), and the settle step that closes a proposal or returns it to
 * review.
 *
 * External boundaries mocked: Prisma client only.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	findUnique: vi.fn(),
	updateMany: vi.fn(),
	applications: vi.fn(),
	duplicates: vi.fn(),
}));

vi.mock("../prisma/client", () => ({
	db: {
		pendingBacklogProposal: {
			findUnique: mocks.findUnique,
			updateMany: mocks.updateMany,
		},
		pendingBacklogProposalApplication: { findMany: mocks.applications },
		pendingBacklogProposalDuplicateResolution: {
			findMany: mocks.duplicates,
		},
	},
	Prisma: {},
}));

import {
	computeProposalItemState,
	listProposalItemStates,
	readRejectedChangeIndexes,
	settleAppliedProposal,
	settleCreatesOnlyApply,
} from "../prisma/queries/projects/pending-proposal-item-state";

beforeEach(() => {
	vi.resetAllMocks();
	mocks.applications.mockResolvedValue([]);
	mocks.duplicates.mockResolvedValue([]);
	mocks.updateMany.mockResolvedValue({ count: 1 });
});

describe("readRejectedChangeIndexes", () => {
	it("returns unique, sorted, non-negative integer indexes", () => {
		expect(
			readRejectedChangeIndexes({
				rejectedChangeIndexes: [3, 1, 3, -1, 1.5, "2"],
				other: true,
			}),
		).toEqual([1, 3]);
	});

	it.each([null, undefined, [], "x", {}, { rejectedChangeIndexes: 2 }])(
		"returns nothing for %j",
		(value) => {
			expect(readRejectedChangeIndexes(value)).toEqual([]);
		},
	);
});

describe("computeProposalItemState", () => {
	it("unions every resolution source within the proposal's own indexes", () => {
		const state = computeProposalItemState({
			changeCount: 5,
			appliedChangeIndexes: [0, 9],
			applicationIndexes: [1],
			duplicateIndexes: [2],
			rejectedChangeIndexes: [3],
		});
		const sorted = (set: Set<number>) => [...set].sort((a, b) => a - b);
		expect(sorted(state.applied)).toEqual([0, 1, 2]);
		expect(sorted(state.rejected)).toEqual([3]);
		expect(sorted(state.resolved)).toEqual([0, 1, 2, 3]);
		expect(state.remainingCount).toBe(1);
	});

	it("counts an index resolved twice once", () => {
		const state = computeProposalItemState({
			changeCount: 2,
			appliedChangeIndexes: [0],
			applicationIndexes: [0],
			duplicateIndexes: [],
			rejectedChangeIndexes: [1],
		});
		expect(state.remainingCount).toBe(0);
	});
});

describe("settleAppliedProposal", () => {
	it("returns the proposal to review while an item is undecided", async () => {
		mocks.findUnique.mockResolvedValue({
			changeCount: 3,
			appliedChangeIndexes: [0],
			sourceMetadata: { rejectedChangeIndexes: [1] },
		});

		const settled = await settleAppliedProposal({
			proposalId: "example-proposal",
			where: { status: "APPLYING", applyWorkflowId: "example-workflow" },
		});

		expect(settled).toEqual({ status: "PENDING", remainingCount: 1 });
		expect(mocks.updateMany).toHaveBeenCalledWith({
			where: {
				id: "example-proposal",
				status: "APPLYING",
				applyWorkflowId: "example-workflow",
			},
			data: {
				status: "PENDING",
				applyWorkflowId: null,
				applyStartedAt: null,
				applyError: null,
				errorClass: null,
				errorMessage: null,
				failedAt: null,
			},
		});
	});

	it("closes the proposal once every item is resolved", async () => {
		mocks.findUnique.mockResolvedValue({
			changeCount: 2,
			appliedChangeIndexes: [],
			sourceMetadata: null,
		});
		mocks.applications.mockResolvedValue([{ changeIndex: 0 }]);
		mocks.duplicates.mockResolvedValue([{ changeIndex: 1 }]);

		const settled = await settleAppliedProposal({
			proposalId: "example-proposal",
		});

		expect(settled).toEqual({ status: "APPLIED", remainingCount: 0 });
		const call = mocks.updateMany.mock.calls[0]?.[0];
		expect(call.where).toEqual({ id: "example-proposal" });
		expect(call.data).toMatchObject({
			status: "APPLIED",
			applyError: null,
		});
		expect(call.data.appliedAt).toBeInstanceOf(Date);
	});

	it("is null when the claim no longer matches", async () => {
		mocks.findUnique.mockResolvedValue({
			changeCount: 1,
			appliedChangeIndexes: [0],
			sourceMetadata: null,
		});
		mocks.updateMany.mockResolvedValue({ count: 0 });

		await expect(
			settleAppliedProposal({
				proposalId: "example-proposal",
				where: { status: "APPLYING", applyWorkflowId: "example-other" },
			}),
		).resolves.toBeNull();
	});

	it("is null for a missing row, without writing", async () => {
		mocks.findUnique.mockResolvedValue(null);

		await expect(
			settleAppliedProposal({ proposalId: "example-proposal" }),
		).resolves.toBeNull();
		expect(mocks.updateMany).not.toHaveBeenCalled();
	});
});

describe("settleCreatesOnlyApply", () => {
	it("reports the items still in review", async () => {
		mocks.findUnique.mockResolvedValue({
			changeCount: 3,
			appliedChangeIndexes: [0],
			sourceMetadata: null,
		});

		await expect(
			settleCreatesOnlyApply({ proposalId: "example-proposal" }),
		).resolves.toEqual({ status: "pending", remainingChangeCount: 2 });
	});

	it("reports applied once every item is resolved", async () => {
		mocks.findUnique.mockResolvedValue({
			changeCount: 1,
			appliedChangeIndexes: [0],
			sourceMetadata: null,
		});

		await expect(
			settleCreatesOnlyApply({ proposalId: "example-proposal" }),
		).resolves.toEqual({ status: "applied", remainingChangeCount: 0 });
	});

	it("reads a row settled by someone else as applied", async () => {
		mocks.findUnique.mockResolvedValue({
			changeCount: 3,
			appliedChangeIndexes: [0],
			sourceMetadata: null,
		});
		mocks.updateMany.mockResolvedValue({ count: 0 });

		await expect(
			settleCreatesOnlyApply({
				proposalId: "example-proposal",
				where: { status: "APPLIED" },
			}),
		).resolves.toEqual({ status: "applied", remainingChangeCount: 0 });
	});
});

describe("computeProposalItemState — reasons", () => {
	it("names why each resolved item left review", () => {
		const state = computeProposalItemState({
			changeCount: 5,
			appliedChangeIndexes: [0, 2],
			applicationIndexes: [1],
			duplicateIndexes: [2],
			rejectedChangeIndexes: [4],
		});
		expect(state.resolvedItems).toEqual([
			{ changeIndex: 0, reason: "applied" },
			{ changeIndex: 1, reason: "applied" },
			{ changeIndex: 2, reason: "duplicate" },
			{ changeIndex: 4, reason: "rejected" },
		]);
	});
});

describe("listProposalItemStates", () => {
	it("reads every row's state from two batched queries", async () => {
		mocks.applications.mockResolvedValue([
			{ proposalId: "example-a", changeIndex: 0 },
		]);
		mocks.duplicates.mockResolvedValue([
			{ proposalId: "example-b", changeIndex: 1 },
		]);

		const [first, second] = await listProposalItemStates([
			{
				id: "example-a",
				changeCount: 2,
				appliedChangeIndexes: [],
				sourceMetadata: { rejectedChangeIndexes: [1] },
			},
			{
				id: "example-b",
				changeCount: 2,
				appliedChangeIndexes: [],
				sourceMetadata: null,
			},
		]);

		expect(mocks.applications).toHaveBeenCalledTimes(1);
		expect(mocks.duplicates).toHaveBeenCalledTimes(1);
		expect(first.remainingCount).toBe(0);
		expect(second.resolvedItems).toEqual([
			{ changeIndex: 1, reason: "duplicate" },
		]);
	});

	it("does not query for an empty list", async () => {
		await expect(listProposalItemStates([])).resolves.toEqual([]);
		expect(mocks.applications).not.toHaveBeenCalled();
		expect(mocks.duplicates).not.toHaveBeenCalled();
	});
});
