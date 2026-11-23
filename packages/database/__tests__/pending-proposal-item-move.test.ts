/**
 * Per-item "Move to Rejected": the item moves into its own BACKLOG row and
 * the original records it in `sourceMetadata.rejectedChangeIndexes`, under a
 * compare-and-set on status and metadata; a single undecided item moves the
 * whole row; the last undecided item closes the original.
 *
 * External boundaries mocked: Prisma client only.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	findUnique: vi.fn(),
	updateMany: vi.fn(),
	create: vi.fn(),
	applications: vi.fn(),
	duplicates: vi.fn(),
	drafts: vi.fn(),
	copyDrafts: vi.fn(),
	findMany: vi.fn(),
}));

vi.mock("../prisma/client", () => {
	const tx = {
		pendingBacklogProposal: {
			findUnique: mocks.findUnique,
			updateMany: mocks.updateMany,
			create: mocks.create,
		},
		pendingBacklogProposalApplication: { findMany: mocks.applications },
		pendingBacklogProposalDuplicateResolution: {
			findMany: mocks.duplicates,
		},
		backlogProposalDraft: {
			findMany: mocks.drafts,
			createMany: mocks.copyDrafts,
		},
	};
	return {
		db: {
			$transaction: async (run: (client: unknown) => unknown) => run(tx),
			pendingBacklogProposal: { findMany: mocks.findMany },
		},
		Prisma: { AnyNull: "example-any-null" },
	};
});

import {
	listRestoredProposalItems,
	movePendingProposalItemToBacklog,
	splitItemSourceMetadata,
} from "../prisma/queries/projects/pending-proposal-item-move";

const changeA = { action: "create", type: "feature", title: { to: "A" } };
const changeB = { action: "create", type: "bug", title: { to: "B" } };
const changeC = { action: "update", type: "feature", title: { to: "C" } };

function row(overrides: Record<string, unknown> = {}) {
	return {
		projectId: "example-project",
		source: "TEAMS_CHANNEL",
		status: "PENDING",
		proposal: { summary: "", changes: [changeA, changeB, changeC] },
		summary: "A (+2 more)",
		changeCount: 3,
		sourceMetadata: { threadRootId: "example-thread" },
		appliedChangeIndexes: [],
		appliedAt: null,
		userId: "example-owner",
		organizationId: "example-org",
		...overrides,
	};
}

const move = (changeIndex: number) =>
	movePendingProposalItemToBacklog({
		proposalId: "example-proposal",
		changeIndex,
		reviewedBy: "example-reviewer",
	});

beforeEach(() => {
	vi.resetAllMocks();
	mocks.applications.mockResolvedValue([]);
	mocks.duplicates.mockResolvedValue([]);
	mocks.updateMany.mockResolvedValue({ count: 1 });
	mocks.create.mockResolvedValue({ id: "example-split" });
	mocks.drafts.mockResolvedValue([]);
});

describe("movePendingProposalItemToBacklog", () => {
	it("splits the item into a BACKLOG row and records it on the original", async () => {
		mocks.findUnique.mockResolvedValue(row());

		await expect(move(1)).resolves.toEqual({
			outcome: "split",
			splitProposalId: "example-split",
		});

		expect(mocks.create).toHaveBeenCalledWith({
			data: {
				projectId: "example-project",
				source: "TEAMS_CHANNEL",
				status: "BACKLOG",
				proposal: { summary: "", changes: [changeB] },
				summary: "B",
				changeCount: 1,
				sourceMetadata: {
					threadRootId: "example-thread",
					splitFrom: {
						proposalId: "example-proposal",
						changeIndex: 1,
					},
				},
				userId: "example-owner",
				organizationId: "example-org",
				reviewedAt: expect.any(Date),
				reviewedBy: "example-reviewer",
			},
			select: { id: true },
		});
		expect(mocks.updateMany).toHaveBeenCalledWith({
			where: {
				id: "example-proposal",
				status: "PENDING",
				proposal: {
					equals: {
						summary: "",
						changes: [changeA, changeB, changeC],
					},
				},
				sourceMetadata: { equals: { threadRootId: "example-thread" } },
			},
			data: {
				sourceMetadata: {
					threadRootId: "example-thread",
					rejectedChangeIndexes: [1],
				},
			},
		});
	});

	it("compares a missing metadata bag against any null", async () => {
		mocks.findUnique.mockResolvedValue(row({ sourceMetadata: null }));

		await move(0);

		const where = mocks.updateMany.mock.calls[0]?.[0].where;
		expect(where.sourceMetadata).toEqual({ equals: "example-any-null" });
	});

	it("closes the original as APPLIED when the last undecided item leaves after an apply", async () => {
		mocks.findUnique.mockResolvedValue(
			row({
				appliedChangeIndexes: [0],
				sourceMetadata: { rejectedChangeIndexes: [2] },
			}),
		);

		await move(1);

		expect(mocks.updateMany.mock.calls[0]?.[0].data).toEqual({
			sourceMetadata: { rejectedChangeIndexes: [1, 2] },
			status: "APPLIED",
			appliedAt: expect.any(Date),
			applyError: null,
			errorClass: null,
			errorMessage: null,
			failedAt: null,
		});
	});

	it("closes the original as REJECTED when every item was moved to Rejected", async () => {
		mocks.findUnique.mockResolvedValue(
			row({ sourceMetadata: { rejectedChangeIndexes: [0, 2] } }),
		);

		await move(1);

		expect(mocks.updateMany.mock.calls[0]?.[0].data).toEqual({
			sourceMetadata: { rejectedChangeIndexes: [0, 1, 2] },
			status: "REJECTED",
			reviewedAt: expect.any(Date),
			reviewedBy: "example-reviewer",
		});
	});

	it("moves the whole row when it holds a single undecided item", async () => {
		mocks.findUnique.mockResolvedValue(
			row({ proposal: { changes: [changeA] }, changeCount: 1 }),
		);

		await expect(move(0)).resolves.toEqual({ outcome: "moved" });

		expect(mocks.create).not.toHaveBeenCalled();
		expect(mocks.updateMany).toHaveBeenCalledWith({
			where: { id: "example-proposal", status: "PENDING" },
			data: {
				status: "BACKLOG",
				reviewedAt: expect.any(Date),
				reviewedBy: "example-reviewer",
			},
		});
	});

	it.each([
		["an applied item", { appliedChangeIndexes: [1] }],
		["a rejected item", { sourceMetadata: { rejectedChangeIndexes: [1] } }],
		["a proposal being applied", { status: "APPLYING" }],
	])(
		"refuses %s as already resolved, writing nothing",
		async (_label, overrides) => {
			mocks.findUnique.mockResolvedValue(row(overrides));

			await expect(move(1)).resolves.toEqual({
				outcome: "already_resolved",
			});

			expect(mocks.create).not.toHaveBeenCalled();
			expect(mocks.updateMany).not.toHaveBeenCalled();
		},
	);

	it("refuses an index outside the proposal", async () => {
		mocks.findUnique.mockResolvedValue(row());

		await expect(move(3)).resolves.toEqual({ outcome: "invalid_index" });
		expect(mocks.create).not.toHaveBeenCalled();
	});

	it("reports a changed proposal when the compare-and-set loses a race", async () => {
		mocks.findUnique.mockResolvedValue(row());
		mocks.updateMany.mockResolvedValue({ count: 0 });

		await expect(move(1)).resolves.toEqual({
			outcome: "proposal_changed",
		});
	});

	it("moves an item of a FAILED proposal, keeping the row FAILED", async () => {
		mocks.findUnique.mockResolvedValue(row({ status: "FAILED" }));

		await expect(move(1)).resolves.toEqual({
			outcome: "split",
			splitProposalId: "example-split",
		});

		const call = mocks.updateMany.mock.calls[0]?.[0];
		expect(call.where.status).toBe("FAILED");
		expect(call.data).toEqual({
			sourceMetadata: {
				threadRootId: "example-thread",
				rejectedChangeIndexes: [1],
			},
		});
	});

	it("closes a FAILED proposal as APPLIED and drops its failure", async () => {
		mocks.findUnique.mockResolvedValue(
			row({
				status: "FAILED",
				appliedChangeIndexes: [0],
				sourceMetadata: { rejectedChangeIndexes: [2] },
			}),
		);

		await move(1);

		const call = mocks.updateMany.mock.calls[0]?.[0];
		expect(call.where.status).toBe("FAILED");
		expect(call.data).toMatchObject({
			status: "APPLIED",
			errorClass: null,
			errorMessage: null,
			failedAt: null,
		});
	});

	it("copies the finished drafts of the moved item to its new row", async () => {
		mocks.findUnique.mockResolvedValue(row());
		const draft = {
			kind: "FEATURE",
			description: "Reviewed body",
			acceptanceCriteria: "Reviewed criteria",
			needsMoreInfo: null,
			startedAt: new Date("2026-01-01T00:00:00Z"),
			completedAt: new Date("2026-01-01T00:01:00Z"),
			createdBy: "example-reviewer",
		};
		mocks.drafts.mockResolvedValue([draft]);

		await move(0);

		expect(mocks.drafts).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					proposalId: "example-proposal",
					status: "COMPLETED",
				},
			}),
		);
		expect(mocks.copyDrafts).toHaveBeenCalledWith({
			data: [
				{
					...draft,
					proposalId: "example-split",
					status: "COMPLETED",
				},
			],
		});
	});

	it("leaves the drafts alone when another item moves", async () => {
		mocks.findUnique.mockResolvedValue(row());

		await move(1);

		expect(mocks.drafts).not.toHaveBeenCalled();
		expect(mocks.copyDrafts).not.toHaveBeenCalled();
	});
});

describe("splitItemSourceMetadata", () => {
	it("keeps this item's findings re-indexed to 0 and proposal-level ones", () => {
		const metadata = {
			transcript: "example transcript",
			rejectedChangeIndexes: [0],
			decisionPrecheck: {
				status: "conflicts",
				checkedAt: "2026-01-01T00:00:00.000Z",
				findings: [
					{ decisionId: "d-1", changeRef: { index: 2, title: "C" } },
					{ decisionId: "d-2", changeRef: { index: 1, title: "B" } },
					{ decisionId: "d-3" },
				],
			},
		};

		expect(splitItemSourceMetadata(metadata, 2)).toEqual({
			transcript: "example transcript",
			decisionPrecheck: {
				status: "conflicts",
				checkedAt: "2026-01-01T00:00:00.000Z",
				findings: [
					{ decisionId: "d-1", changeRef: { index: 0, title: "C" } },
					{ decisionId: "d-3" },
				],
			},
		});
	});

	it("marks the pre-check ok when no finding belongs to the item", () => {
		expect(
			splitItemSourceMetadata(
				{
					decisionPrecheck: {
						status: "conflicts",
						findings: [
							{ decisionId: "d-1", changeRef: { index: 0 } },
						],
					},
				},
				1,
			),
		).toEqual({ decisionPrecheck: { status: "ok", findings: [] } });
	});

	it("leaves a missing bag missing", () => {
		expect(splitItemSourceMetadata(null, 0)).toBeUndefined();
	});
});

describe("listRestoredProposalItems", () => {
	it("finds the split rows that left the Rejected list, with their tickets", async () => {
		mocks.findMany.mockResolvedValue([
			{
				status: "APPLIED",
				sourceMetadata: {
					splitFrom: {
						proposalId: "example-proposal",
						changeIndex: 2,
					},
				},
				applications: [{ createdEntityId: "example-story" }],
			},
			{
				status: "PENDING",
				sourceMetadata: {
					splitFrom: {
						proposalId: "example-proposal",
						changeIndex: 0,
					},
				},
				applications: [],
			},
			{
				status: "APPLIED",
				sourceMetadata: { splitFrom: { changeIndex: "1" } },
				applications: [],
			},
		]);

		await expect(
			listRestoredProposalItems({
				id: "example-proposal",
				projectId: "example-project",
			}),
		).resolves.toEqual([
			{ changeIndex: 2, storyId: "example-story" },
			{ changeIndex: 0, storyId: null },
		]);

		const where = mocks.findMany.mock.calls[0]?.[0].where;
		expect(where).toEqual({
			projectId: "example-project",
			status: {
				in: ["PENDING", "APPROVED", "APPLYING", "APPLIED", "FAILED"],
			},
			sourceMetadata: {
				path: ["splitFrom", "proposalId"],
				equals: "example-proposal",
			},
		});
	});

	it.each(["APPLYING", "FAILED"])(
		"returns no ticket for a restore whose split row is %s",
		async (status) => {
			mocks.findMany.mockResolvedValue([
				{
					status,
					sourceMetadata: {
						splitFrom: {
							proposalId: "example-proposal",
							changeIndex: 2,
						},
					},
					applications: [{ createdEntityId: "example-story" }],
				},
			]);

			await expect(
				listRestoredProposalItems({
					id: "example-proposal",
					projectId: "example-project",
				}),
			).resolves.toEqual([{ changeIndex: 2, storyId: null }]);
		},
	);
});
