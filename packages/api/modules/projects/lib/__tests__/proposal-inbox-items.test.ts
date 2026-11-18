/**
 * Review-inbox list rows carry compact summaries of the items still waiting
 * for a decision instead of the raw proposal JSON, and both list rows and
 * single-proposal reads carry the server's per-item state.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	listApplications: vi.fn(),
	listDuplicates: vi.fn(),
	listStates: vi.fn(),
	findStories: vi.fn(),
}));

vi.mock("../../../../../database/prisma/client", () => ({ db: {} }));
vi.mock("@repo/database", async () => {
	const changes = await import(
		"../../../../../database/prisma/queries/projects/proposal-changes"
	);
	const itemState = await import(
		"../../../../../database/prisma/queries/projects/pending-proposal-item-state"
	);
	return {
		computeProposalItemState: itemState.computeProposalItemState,
		db: { userStory: { findMany: mocks.findStories } },
		listProposalApplications: mocks.listApplications,
		listProposalDuplicateResolutions: mocks.listDuplicates,
		listProposalItemStates: mocks.listStates,
		proposalRevision: changes.proposalRevision,
		readRejectedChangeIndexes: itemState.readRejectedChangeIndexes,
		readStoredProposalChanges: changes.readStoredProposalChanges,
		targetChangedSinceProposal: changes.targetChangedSinceProposal,
	};
});

import { computeProposalItemState } from "../../../../../database/prisma/queries/projects/pending-proposal-item-state";
import { proposalRevision } from "../../../../../database/prisma/queries/projects/proposal-changes";
import {
	loadProposalItemOutcomes,
	summarizeProposalItems,
	toProposalInboxRow,
	toProposalInboxRows,
} from "../proposal-inbox-items";

function stateOf(
	changeCount: number,
	resolved: {
		applied?: number[];
		duplicate?: number[];
		rejected?: number[];
	} = {},
) {
	return computeProposalItemState({
		changeCount,
		appliedChangeIndexes: resolved.applied ?? [],
		applicationIndexes: [],
		duplicateIndexes: resolved.duplicate ?? [],
		rejectedChangeIndexes: resolved.rejected ?? [],
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.listApplications.mockResolvedValue([]);
	mocks.listDuplicates.mockResolvedValue([]);
	mocks.findStories.mockResolvedValue([]);
});

describe("summarizeProposalItems", () => {
	it("returns the index, title and identifier of each change", () => {
		expect(
			summarizeProposalItems({
				changes: [
					{ action: "create", title: { to: "  New idea  " } },
					{
						action: "update",
						title: { from: "Old", to: "Renamed" },
						existingIdentifier: "F-12",
					},
					{
						action: "update",
						title: { to: "Resolved target" },
						targetResolution: {
							status: "resolved",
							resolvedIdentifier: "F-7",
						},
					},
					{ action: "update", title: { from: "Only from", to: "" } },
					"not a change",
				],
			}),
		).toEqual([
			{ changeIndex: 0, title: "New idea", identifier: null },
			{ changeIndex: 1, title: "Renamed", identifier: "F-12" },
			{ changeIndex: 2, title: "Resolved target", identifier: "F-7" },
			{ changeIndex: 3, title: "Only from", identifier: null },
			{ changeIndex: 4, title: "", identifier: null },
		]);
	});

	it("leaves out resolved items, so a search cannot match them", () => {
		expect(
			summarizeProposalItems(
				{
					changes: [
						{ title: { to: "Applied" } },
						{ title: { to: "Open" } },
						{ title: { to: "Rejected" } },
					],
				},
				new Set([0, 2]),
			),
		).toEqual([{ changeIndex: 1, title: "Open", identifier: null }]);
	});

	it("caps titles at 200 characters", () => {
		const [item] = summarizeProposalItems({
			changes: [{ title: { to: "x".repeat(250) } }],
		});
		expect(item?.title).toHaveLength(200);
	});

	it.each([null, {}, { changes: "x" }, []])(
		"returns no items for %j",
		(proposal) => {
			expect(summarizeProposalItems(proposal)).toEqual([]);
		},
	);
});

const listRow = {
	id: "example-proposal",
	changeCount: 3,
	appliedChangeIndexes: [] as number[],
	proposal: {
		changes: [
			{ title: { to: "A" } },
			{ title: { to: "B" } },
			{ title: { to: "C" } },
		],
	},
	sourceMetadata: { rejectedChangeIndexes: [1] },
};

describe("toProposalInboxRow", () => {
	it("replaces the raw proposal with the open items and the resolved set", () => {
		const row = toProposalInboxRow(
			listRow,
			stateOf(3, { duplicate: [0], rejected: [1] }),
		);

		expect(row).toEqual({
			id: "example-proposal",
			changeCount: 3,
			appliedChangeIndexes: [],
			sourceMetadata: { rejectedChangeIndexes: [1] },
			items: [{ changeIndex: 2, title: "C", identifier: null }],
			rejectedChangeIndexes: [1],
			duplicateChangeIndexes: [0],
			resolvedItems: [
				{ changeIndex: 0, reason: "duplicate" },
				{ changeIndex: 1, reason: "rejected" },
			],
			remainingCount: 1,
		});
		expect(row).not.toHaveProperty("proposal");
	});
});

describe("toProposalInboxRows", () => {
	it("reads every row's state in one batch and pairs it with its row", async () => {
		const other = { ...listRow, id: "example-other", sourceMetadata: null };
		mocks.listStates.mockResolvedValue([
			stateOf(3, { applied: [0, 1, 2] }),
			stateOf(3),
		]);

		const rows = await toProposalInboxRows([listRow, other]);

		expect(mocks.listStates).toHaveBeenCalledTimes(1);
		expect(mocks.listStates).toHaveBeenCalledWith([listRow, other]);
		expect(rows.map((row) => row.remainingCount)).toEqual([0, 3]);
		expect(rows.map((row) => row.items.length)).toEqual([0, 3]);
	});
});

describe("loadProposalItemOutcomes", () => {
	const detail = {
		id: "example-proposal",
		projectId: "example-project",
		changeCount: 4,
		appliedChangeIndexes: [] as number[],
		sourceMetadata: { rejectedChangeIndexes: [1] },
		proposal: {
			changes: [
				{ action: "create", title: { to: "A" } },
				{ action: "create", title: { to: "B" } },
				{ action: "update", title: { to: "C" } },
				{ action: "create", title: { to: "D" } },
			],
		},
	};

	it("returns the outcomes, the resolved set and the proposal revision", async () => {
		const applications = [
			{ changeIndex: 0, createdEntityId: "story-1", action: "create" },
			{ changeIndex: 2, createdEntityId: null, action: "update" },
		];
		const duplicateResolutions = [
			{ changeIndex: 3, existingEntityId: "example-existing-story" },
		];
		mocks.listApplications.mockResolvedValue(applications);
		mocks.listDuplicates.mockResolvedValue(duplicateResolutions);

		await expect(loadProposalItemOutcomes(detail)).resolves.toEqual({
			applications,
			createdChangeIndexes: [0, 2],
			duplicateResolutions,
			duplicateChangeIndexes: [3],
			rejectedChangeIndexes: [1],
			resolvedItems: [
				{ changeIndex: 0, reason: "applied" },
				{ changeIndex: 1, reason: "rejected" },
				{ changeIndex: 2, reason: "applied" },
				{ changeIndex: 3, reason: "duplicate" },
			],
			remainingCount: 0,
			proposalRevision: proposalRevision(detail.proposal),
			targetChangedSinceProposalIndexes: [],
		});
		expect(mocks.listApplications).toHaveBeenCalledWith("example-proposal");
		expect(mocks.listDuplicates).toHaveBeenCalledWith("example-proposal");
	});

	it("flags the open update items whose ticket changed since analysis", async () => {
		const update = (existingId: string, from: string) => ({
			action: "update",
			title: { to: existingId },
			existingId,
			description: { from, to: `${from} and more` },
		});
		const proposal = {
			changes: [
				update("story-edited", "Original body"),
				update("story-unchanged", "Same body"),
				update("story-resolved", "Original body"),
				{ action: "update", title: { to: "No diff" }, existingId: "x" },
			],
		};
		mocks.findStories.mockResolvedValue([
			{
				id: "story-edited",
				description: "Edited after analysis",
				acceptanceCriteria: null,
			},
			{
				id: "story-unchanged",
				description: "Same body\r\n",
				acceptanceCriteria: null,
			},
			{
				id: "story-resolved",
				description: "Edited after analysis",
				acceptanceCriteria: null,
			},
		]);

		const outcomes = await loadProposalItemOutcomes({
			...detail,
			sourceMetadata: { rejectedChangeIndexes: [2] },
			proposal,
		});

		expect(outcomes.targetChangedSinceProposalIndexes).toEqual([0]);
		expect(mocks.findStories).toHaveBeenCalledWith({
			where: {
				id: { in: ["story-edited", "story-unchanged"] },
				projectId: "example-project",
			},
			select: { id: true, description: true, acceptanceCriteria: true },
		});
	});

	it("does not read tickets when no open update carries a diff", async () => {
		const outcomes = await loadProposalItemOutcomes(detail);

		expect(outcomes.targetChangedSinceProposalIndexes).toEqual([]);
		expect(mocks.findStories).not.toHaveBeenCalled();
	});
});
