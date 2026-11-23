/**
 * Duplicate detection against the Proposal Inbox, database side: which
 * pending items take part (unresolved create items only, capped), and the
 * compare-and-set merge of a manual entry into one of them.
 *
 * External boundaries mocked: Prisma client only.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_FOCUS_CHARS } from "../prisma/queries/projects/duplicate-focus";

const mocks = vi.hoisted(() => ({
	findUnique: vi.fn(),
	findMany: vi.fn(),
	updateMany: vi.fn(),
	applications: vi.fn(),
	duplicates: vi.fn(),
}));

vi.mock("../prisma/client", () => {
	const client = {
		pendingBacklogProposal: {
			findUnique: mocks.findUnique,
			findMany: mocks.findMany,
			updateMany: mocks.updateMany,
		},
		pendingBacklogProposalApplication: { findMany: mocks.applications },
		pendingBacklogProposalDuplicateResolution: {
			findMany: mocks.duplicates,
		},
	};
	return {
		db: {
			...client,
			$transaction: async (run: (tx: unknown) => unknown) => run(client),
		},
		Prisma: { AnyNull: "example-any-null" },
	};
});

import {
	appendManualEntry,
	exceedsMergedDescriptionLimit,
	MANUAL_ENTRY_HEADING,
	MERGED_DESCRIPTION_MAX_LENGTH,
	mergeIntoPendingProposalItem,
	mergeManualEntryIntoChange,
} from "../prisma/queries/projects/pending-proposal-item-merge";
import {
	listUnresolvedPendingProposalItems,
	unresolvedNewWorkItems,
} from "../prisma/queries/projects/pending-proposal-match-items";
import { readStoredChangeEntry } from "../prisma/queries/projects/proposal-changes";

const createA = {
	action: "create",
	type: "feature",
	title: { to: "Queue exports" },
	description: { to: "Exports need a queue." },
};
const createB = { action: "create", type: "bug", title: { to: "Retry" } };
const updateC = {
	action: "update",
	type: "feature",
	existingId: "example-story",
	title: { to: "Existing" },
};

const CAPTURED_AT = new Date("2026-11-02T09:00:00.000Z");

function row(overrides: Record<string, unknown> = {}) {
	return {
		id: "example-proposal",
		projectId: "example-project",
		source: "SLACK_CHANNEL",
		status: "PENDING",
		summary: "Queue exports (+2 more)",
		proposal: { summary: "", changes: [createA, createB, updateC] },
		changeCount: 3,
		appliedChangeIndexes: [],
		sourceMetadata: { threadRootId: "example-thread" },
		createdAt: CAPTURED_AT,
		...overrides,
	};
}

const merge = (changeIndex: number, projectId = "example-project") =>
	mergeIntoPendingProposalItem({
		projectId,
		proposalId: "example-proposal",
		changeIndex,
		addition: "  Also cap export size.  ",
		addedBy: "Example Person",
	});

beforeEach(() => {
	vi.resetAllMocks();
	mocks.applications.mockResolvedValue([]);
	mocks.duplicates.mockResolvedValue([]);
	mocks.updateMany.mockResolvedValue({ count: 1 });
});

describe("appendManualEntry", () => {
	it("appends the entry under an attributed heading after a rule", () => {
		expect(appendManualEntry("Existing body.", " New text ", "Ada")).toBe(
			`Existing body.\n\n---\n\n${MANUAL_ENTRY_HEADING} (by Ada):\n\nNew text`,
		);
	});

	it("uses the entry alone, without a rule, when there is no description", () => {
		expect(appendManualEntry("  ", "New text", null)).toBe(
			`${MANUAL_ENTRY_HEADING}:\n\nNew text`,
		);
	});
});

describe("mergeManualEntryIntoChange", () => {
	it("extends description.to and keeps description.from", () => {
		const merged = mergeManualEntryIntoChange(
			{ ...createA, description: { from: "Old", to: "Body" } },
			"More",
			null,
		);
		expect(merged.description).toEqual({
			from: "Old",
			to: `Body\n\n---\n\n${MANUAL_ENTRY_HEADING}:\n\nMore`,
		});
		expect(merged.title).toEqual(createA.title);
	});

	it("creates a description when the item has none, or a bare string", () => {
		expect(
			mergeManualEntryIntoChange(createB, "More", null).description,
		).toEqual({ to: `${MANUAL_ENTRY_HEADING}:\n\nMore` });
		expect(
			mergeManualEntryIntoChange(
				{ ...createB, description: "Plain" },
				"More",
				null,
			).description,
		).toEqual({ to: `Plain\n\n---\n\n${MANUAL_ENTRY_HEADING}:\n\nMore` });
	});

	it("extends the captured routing description a routing override re-submits", () => {
		const merged = mergeManualEntryIntoChange(
			{
				...createA,
				routing: {
					decision: "create",
					proposedDescription: "Captured",
				},
			},
			"More",
			null,
		);
		expect(merged.routing).toEqual({
			decision: "create",
			proposedDescription: `Captured\n\n---\n\n${MANUAL_ENTRY_HEADING}:\n\nMore`,
		});
	});
});

describe("unresolvedNewWorkItems", () => {
	it("keeps unresolved create items with a title, in index order", () => {
		const items = unresolvedNewWorkItems(
			{
				id: "example-proposal",
				source: "SLACK_CHANNEL",
				summary: "Summary",
				proposal: {
					changes: [createA, createB, updateC, { action: "create" }],
				},
				changeCount: 4,
				createdAt: CAPTURED_AT,
			},
			new Set([1]),
		);
		expect(items).toEqual([
			{
				proposalId: "example-proposal",
				changeIndex: 0,
				source: "SLACK_CHANNEL",
				proposalSummary: "Summary",
				createdAt: CAPTURED_AT,
				title: "Queue exports",
				description: "Exports need a queue.",
				acceptanceCriteria: "",
				focusTexts: {},
			},
		]);
	});

	it("caps the title and bodies read from the proposal JSON", () => {
		const [item] = unresolvedNewWorkItems(
			{
				id: "example-proposal",
				source: "SLACK_CHANNEL",
				summary: "",
				proposal: {
					changes: [
						{
							action: "create",
							title: "t".repeat(500),
							description: "d".repeat(20_000),
							acceptanceCriteria: { to: "a".repeat(20_000) },
						},
					],
				},
				changeCount: 1,
				createdAt: CAPTURED_AT,
			},
			new Set(),
		);
		expect(item?.title).toHaveLength(200);
		expect(item?.description).toHaveLength(2_000);
		expect(item?.acceptanceCriteria).toHaveLength(1_000);
		expect(item?.focusTexts?.acceptance_criteria).toHaveLength(
			MAX_FOCUS_CHARS,
		);
	});

	it("reads a feature's Scope section past the description cap, and none for a bug", () => {
		const description = [
			"## Overview",
			"o".repeat(3_000),
			"## Scope",
			"### In Scope",
			"- Queue large exports",
			"### Out of Scope",
			"- Scheduled exports",
		].join("\n");
		const [feature, bug] = unresolvedNewWorkItems(
			{
				id: "example-proposal",
				source: "SLACK_CHANNEL",
				summary: "",
				proposal: {
					changes: [
						{
							action: "create",
							type: "feature",
							title: "Queue exports",
							description,
						},
						{
							action: "create",
							type: "bug",
							title: "Export fails",
							description,
						},
					],
				},
				changeCount: 2,
				createdAt: CAPTURED_AT,
			},
			new Set(),
		);
		expect(feature?.focusTexts?.scope).toBe(
			"In scope:\n- Queue large exports\nOut of scope:\n- Scheduled exports",
		);
		expect(bug?.focusTexts).toBeNull();
	});

	it("reads a description from description.to or a bare string", () => {
		const description = (change: unknown) =>
			readStoredChangeEntry(change, 0).description;
		expect(description({ description: { to: " To " } })).toBe("To");
		expect(description({ description: " Bare " })).toBe("Bare");
		expect(description({})).toBe("");
	});
});

describe("listUnresolvedPendingProposalItems", () => {
	it("reads PENDING proposals newest first and drops items resolved anywhere", async () => {
		mocks.findMany.mockResolvedValue([
			row({ id: "p-new" }),
			row({
				id: "p-old",
				sourceMetadata: { rejectedChangeIndexes: [1] },
			}),
		]);
		mocks.applications.mockResolvedValue([
			{ proposalId: "p-new", changeIndex: 0 },
		]);

		const items = await listUnresolvedPendingProposalItems({
			projectId: "example-project",
			maxItems: 10,
		});

		expect(mocks.findMany).toHaveBeenCalledTimes(1);
		expect(mocks.findMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					projectId: "example-project",
					status: "PENDING",
				},
				orderBy: [{ createdAt: "desc" }, { id: "desc" }],
				take: 50,
			}),
		);
		expect(
			items.map((item) => [item.proposalId, item.changeIndex]),
		).toEqual([
			["p-new", 1],
			["p-old", 0],
		]);
	});

	const page = (
		from: number,
		count: number,
		changes: unknown[] = [createA],
	) =>
		Array.from({ length: count }, (_, offset) =>
			row({
				id: `p-${from + offset}`,
				proposal: { summary: "", changes },
				changeCount: changes.length,
			}),
		);

	it("reads past the newest 50 proposals, strictly after the last row read", async () => {
		mocks.findMany
			.mockResolvedValueOnce(page(0, 50))
			.mockResolvedValueOnce(page(50, 10));

		const items = await listUnresolvedPendingProposalItems({
			projectId: "example-project",
			maxItems: 150,
		});

		expect(items).toHaveLength(60);
		expect(items.at(-1)?.proposalId).toBe("p-59");
		expect(mocks.findMany).toHaveBeenCalledTimes(2);
		const second = mocks.findMany.mock.calls[1]?.[0];
		expect(second).toEqual(
			expect.objectContaining({
				where: {
					projectId: "example-project",
					status: "PENDING",
					OR: [
						{ createdAt: { lt: CAPTURED_AT } },
						{ createdAt: CAPTURED_AT, id: { lt: "p-49" } },
					],
				},
				orderBy: [{ createdAt: "desc" }, { id: "desc" }],
				take: 50,
			}),
		);
		expect(second).not.toHaveProperty("cursor");
		expect(second).not.toHaveProperty("skip");
	});

	it("reads every PENDING proposal when no cap is given, past pages that hold only updates", async () => {
		for (let start = 0; start < 400; start += 50) {
			mocks.findMany.mockResolvedValueOnce(page(start, 50, [updateC]));
		}
		mocks.findMany.mockResolvedValueOnce(page(400, 3));

		const items = await listUnresolvedPendingProposalItems({
			projectId: "example-project",
		});

		expect(mocks.findMany).toHaveBeenCalledTimes(9);
		expect(items.map((item) => item.proposalId)).toEqual([
			"p-400",
			"p-401",
			"p-402",
		]);
	});

	it("stops reading once the signal aborts", async () => {
		const controller = new AbortController();
		mocks.findMany.mockImplementation(async () => {
			controller.abort();
			return page(0, 50, [updateC]);
		});

		await expect(
			listUnresolvedPendingProposalItems({
				projectId: "example-project",
				maxItems: 150,
				signal: controller.signal,
			}),
		).rejects.toThrow();
		expect(mocks.findMany).toHaveBeenCalledTimes(1);
	});

	it("stops reading proposals once the item cap is reached", async () => {
		mocks.findMany.mockResolvedValue(
			Array.from({ length: 50 }, (_, index) => row({ id: `p-${index}` })),
		);

		const items = await listUnresolvedPendingProposalItems({
			projectId: "example-project",
			maxItems: 40,
		});

		expect(items).toHaveLength(40);
		expect(mocks.findMany).toHaveBeenCalledTimes(1);
	});

	it("caps the number of items returned", async () => {
		mocks.findMany.mockResolvedValue([
			row({ id: "p-1" }),
			row({ id: "p-2" }),
		]);

		const items = await listUnresolvedPendingProposalItems({
			projectId: "example-project",
			maxItems: 3,
		});

		expect(items).toHaveLength(3);
	});

	it("skips the per-item queries when nothing is pending", async () => {
		mocks.findMany.mockResolvedValue([]);

		await expect(
			listUnresolvedPendingProposalItems({
				projectId: "example-project",
				maxItems: 10,
			}),
		).resolves.toEqual([]);
		expect(mocks.applications).not.toHaveBeenCalled();
	});
});

describe("mergeIntoPendingProposalItem", () => {
	it("appends the entry to the item under a compare-and-set on the row", async () => {
		mocks.findUnique.mockResolvedValue(row());

		await expect(merge(0)).resolves.toEqual({ outcome: "merged" });

		const call = mocks.updateMany.mock.calls[0]?.[0] as {
			where: Record<string, unknown>;
			data: { proposal: { changes: Record<string, unknown>[] } };
		};
		expect(call.where).toEqual({
			id: "example-proposal",
			status: "PENDING",
			proposal: { equals: row().proposal },
			sourceMetadata: { equals: row().sourceMetadata },
		});
		expect(call.data.proposal.changes[0]?.description).toEqual({
			to: `Exports need a queue.\n\n---\n\n${MANUAL_ENTRY_HEADING} (by Example Person):\n\nAlso cap export size.`,
		});
		expect(call.data.proposal.changes[1]).toEqual(createB);
		expect(call.data.proposal.changes[2]).toEqual(updateC);
	});

	it("matches a null metadata column with AnyNull", async () => {
		mocks.findUnique.mockResolvedValue(row({ sourceMetadata: null }));

		await merge(0);

		const call = mocks.updateMany.mock.calls[0]?.[0] as {
			where: Record<string, unknown>;
		};
		expect(call.where.sourceMetadata).toEqual({
			equals: "example-any-null",
		});
	});

	it("reports not_found for a missing row or one in another project", async () => {
		mocks.findUnique.mockResolvedValue(null);
		await expect(merge(0)).resolves.toEqual({ outcome: "not_found" });

		mocks.findUnique.mockResolvedValue(row());
		await expect(merge(0, "example-other-project")).resolves.toEqual({
			outcome: "not_found",
		});
		expect(mocks.updateMany).not.toHaveBeenCalled();
	});

	it("reports conflict when the proposal left review", async () => {
		mocks.findUnique.mockResolvedValue(row({ status: "APPLYING" }));

		await expect(merge(0)).resolves.toEqual({ outcome: "conflict" });
		expect(mocks.updateMany).not.toHaveBeenCalled();
	});

	it("refuses an update item or an index past the proposal", async () => {
		mocks.findUnique.mockResolvedValue(row());

		await expect(merge(2)).resolves.toEqual({ outcome: "invalid_index" });
		await expect(merge(7)).resolves.toEqual({ outcome: "invalid_index" });
		expect(mocks.updateMany).not.toHaveBeenCalled();
	});

	it("reports conflict for an item already resolved", async () => {
		mocks.findUnique.mockResolvedValue(
			row({ sourceMetadata: { rejectedChangeIndexes: [0] } }),
		);

		await expect(merge(0)).resolves.toEqual({ outcome: "conflict" });
		expect(mocks.updateMany).not.toHaveBeenCalled();
	});

	it("reports conflict when a concurrent write changed the row", async () => {
		mocks.findUnique.mockResolvedValue(row());
		mocks.updateMany.mockResolvedValue({ count: 0 });

		await expect(merge(0)).resolves.toEqual({ outcome: "conflict" });
	});

	it("refuses a merge that would leave the description too long", async () => {
		const long = "x".repeat(MERGED_DESCRIPTION_MAX_LENGTH - 10);
		mocks.findUnique.mockResolvedValue(
			row({
				proposal: {
					changes: [{ ...createA, description: { to: long } }],
				},
				changeCount: 1,
			}),
		);

		await expect(merge(0)).resolves.toEqual({ outcome: "too_long" });
		expect(mocks.updateMany).not.toHaveBeenCalled();
	});

	it("refuses a merge that would leave the captured routing copy too long", async () => {
		const routing = {
			proposedDescription: "x".repeat(MERGED_DESCRIPTION_MAX_LENGTH),
		};
		mocks.findUnique.mockResolvedValue(
			row({
				proposal: { changes: [{ ...createA, routing }] },
				changeCount: 1,
			}),
		);

		await expect(merge(0)).resolves.toEqual({ outcome: "too_long" });
		expect(mocks.updateMany).not.toHaveBeenCalled();
	});
});

describe("exceedsMergedDescriptionLimit", () => {
	it("allows a description exactly at the limit", () => {
		expect(
			exceedsMergedDescriptionLimit({
				description: { to: "x".repeat(MERGED_DESCRIPTION_MAX_LENGTH) },
			}),
		).toBe(false);
		expect(
			exceedsMergedDescriptionLimit({
				description: {
					to: "x".repeat(MERGED_DESCRIPTION_MAX_LENGTH + 1),
				},
			}),
		).toBe(true);
	});
});
