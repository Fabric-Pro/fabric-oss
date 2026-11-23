/**
 * Merging one inbox item into another as its duplicate: the source item's
 * text, read from its own proposal, is appended to the target item under
 * "Merged from a duplicate inbox item", and the source item moves to Rejected
 * with a note naming the target, in one transaction. A source in another
 * project, out of review or not a new ticket is refused before any write.
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
		},
		Prisma: { AnyNull: "example-any-null" },
	};
});

import {
	duplicateItemText,
	mergeDuplicateInboxItem,
} from "../prisma/queries/projects/pending-proposal-item-duplicate-merge";
import { DUPLICATE_ITEM_HEADING } from "../prisma/queries/projects/pending-proposal-item-merge";
import { readStoredChangeEntry } from "../prisma/queries/projects/proposal-changes";

const target = {
	action: "create",
	type: "feature",
	title: { to: "Queue exports" },
	description: { to: "Exports need a queue." },
};
const duplicate = {
	action: "create",
	type: "feature",
	title: { to: "Export queue" },
	description: { to: "Large exports lock the worker." },
	acceptanceCriteria: { to: "- Exports over 10k rows are queued" },
};
const other = { action: "create", type: "bug", title: { to: "Retry" } };
const update = {
	action: "update",
	type: "feature",
	existingId: "example-story",
	title: { to: "Existing" },
};

function row(changes: unknown[], overrides: Record<string, unknown> = {}) {
	return {
		projectId: "example-project",
		source: "TEAMS_CHANNEL",
		status: "PENDING",
		proposal: { summary: "", changes },
		summary: "Summary",
		changeCount: changes.length,
		sourceMetadata: { threadRootId: "example-thread" },
		appliedChangeIndexes: [],
		appliedAt: null,
		userId: "example-owner",
		organizationId: "example-org",
		...overrides,
	};
}

/** Rows by id, as `findUnique` reads them. */
function arrangeRows(rows: Record<string, ReturnType<typeof row> | null>) {
	mocks.findUnique.mockImplementation(
		async ({ where }: { where: { id: string } }) => rows[where.id] ?? null,
	);
}

const mergeDuplicate = (
	source = { proposalId: "example-source", changeIndex: 0 },
) =>
	mergeDuplicateInboxItem({
		projectId: "example-project",
		source,
		target: { proposalId: "example-target", changeIndex: 0 },
		mergedBy: "example-reviewer",
		mergedByName: "Example Person",
	});

beforeEach(() => {
	vi.resetAllMocks();
	mocks.applications.mockResolvedValue([]);
	mocks.duplicates.mockResolvedValue([]);
	mocks.updateMany.mockResolvedValue({ count: 1 });
	mocks.create.mockResolvedValue({ id: "example-split" });
	mocks.drafts.mockResolvedValue([]);
});

describe("duplicateItemText", () => {
	it("carries the title, the description and the acceptance criteria", () => {
		expect(duplicateItemText(readStoredChangeEntry(duplicate, 0))).toBe(
			"Export queue\n\nLarge exports lock the worker.\n\nAcceptance criteria:\n\n- Exports over 10k rows are queued",
		);
	});
});

describe("mergeDuplicateInboxItem", () => {
	it("appends the duplicate to the target and moves it to Rejected with a note", async () => {
		arrangeRows({
			"example-target": row([target]),
			"example-source": row([duplicate, other]),
		});

		await expect(mergeDuplicate()).resolves.toEqual({ outcome: "merged" });

		const [mergeWrite, ledgerWrite] = mocks.updateMany.mock.calls.map(
			(call) => call[0],
		);
		expect(mergeWrite.where.id).toBe("example-target");
		expect(mergeWrite.data.proposal.changes[0].description).toEqual({
			to: `Exports need a queue.\n\n---\n\n${DUPLICATE_ITEM_HEADING} (by Example Person):\n\nExport queue\n\nLarge exports lock the worker.\n\nAcceptance criteria:\n\n- Exports over 10k rows are queued`,
		});
		// The duplicate leaves the other proposal in its own Rejected row,
		// which says where it went.
		expect(mocks.create).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					status: "BACKLOG",
					proposal: { summary: "", changes: [duplicate] },
					reviewedBy: "example-reviewer",
					sourceMetadata: {
						threadRootId: "example-thread",
						rejectionNote: {
							kind: "merged_duplicate",
							intoProposalId: "example-target",
							intoChangeIndex: 0,
							intoItemTitle: "Queue exports",
							mergedAt: expect.any(String),
						},
						splitFrom: {
							proposalId: "example-source",
							changeIndex: 0,
						},
					},
				}),
			}),
		);
		expect(ledgerWrite.where.id).toBe("example-source");
		expect(ledgerWrite.data.sourceMetadata.rejectedChangeIndexes).toEqual([
			0,
		]);
	});

	it("moves a single-item source proposal whole, with the note", async () => {
		arrangeRows({
			"example-target": row([target]),
			"example-source": row([duplicate]),
		});

		await expect(mergeDuplicate()).resolves.toEqual({ outcome: "merged" });

		expect(mocks.create).not.toHaveBeenCalled();
		expect(mocks.updateMany.mock.calls[1]?.[0]).toEqual({
			where: { id: "example-source", status: "PENDING" },
			data: expect.objectContaining({
				status: "BACKLOG",
				sourceMetadata: expect.objectContaining({
					rejectionNote: expect.objectContaining({
						intoProposalId: "example-target",
					}),
				}),
			}),
		});
	});

	it("merges a sibling of the same proposal and moves only the sibling to Rejected", async () => {
		arrangeRows({ "example-target": row([target, duplicate, other]) });

		await expect(
			mergeDuplicateInboxItem({
				projectId: "example-project",
				source: { proposalId: "example-target", changeIndex: 1 },
				target: { proposalId: "example-target", changeIndex: 0 },
				mergedBy: "example-reviewer",
				mergedByName: "Example Person",
			}),
		).resolves.toEqual({ outcome: "merged" });

		const [mergeWrite, ledgerWrite] = mocks.updateMany.mock.calls.map(
			(call) => call[0],
		);
		expect(mergeWrite.where.id).toBe("example-target");
		expect(mergeWrite.data.proposal.changes[0].description.to).toContain(
			"Large exports lock the worker.",
		);
		// The other items of the proposal are left as they were.
		expect(mergeWrite.data.proposal.changes.slice(1)).toEqual([
			duplicate,
			other,
		]);
		expect(mocks.create).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					status: "BACKLOG",
					proposal: { summary: "", changes: [duplicate] },
					sourceMetadata: expect.objectContaining({
						rejectionNote: expect.objectContaining({
							intoProposalId: "example-target",
							intoChangeIndex: 0,
						}),
					}),
				}),
			}),
		);
		expect(ledgerWrite.where.id).toBe("example-target");
		expect(ledgerWrite.data.sourceMetadata.rejectedChangeIndexes).toEqual([
			1,
		]);
		expect(ledgerWrite.data.status).toBeUndefined();
	});

	it("refuses to merge an item into itself, before any read", async () => {
		await expect(
			mergeDuplicate({ proposalId: "example-target", changeIndex: 0 }),
		).resolves.toEqual({ outcome: "same_item" });
		expect(mocks.findUnique).not.toHaveBeenCalled();
	});

	it.each([
		[
			"a source in another project",
			row([duplicate], { projectId: "example-other-project" }),
			"source_not_found",
		],
		["a missing source", null, "source_not_found"],
		[
			"a source out of review",
			row([duplicate], { status: "APPLYING" }),
			"source_resolved",
		],
		[
			"a source item already resolved",
			row([duplicate], {
				sourceMetadata: { rejectedChangeIndexes: [0] },
			}),
			"source_resolved",
		],
		[
			"a source item that updates a ticket",
			row([update]),
			"source_invalid",
		],
	])("refuses %s before any write", async (_label, source, outcome) => {
		arrangeRows({
			"example-target": row([target]),
			"example-source": source,
		});

		await expect(mergeDuplicate()).resolves.toEqual({ outcome });
		expect(mocks.updateMany).not.toHaveBeenCalled();
		expect(mocks.create).not.toHaveBeenCalled();
	});

	it("reports a conflict when a concurrent merge wins the transaction", async () => {
		arrangeRows({
			"example-target": row([target]),
			"example-source": row([duplicate, other]),
		});
		mocks.updateMany.mockRejectedValue(
			Object.assign(new Error("Transaction failed due to a deadlock"), {
				code: "P2034",
			}),
		);

		await expect(mergeDuplicate()).resolves.toEqual({
			outcome: "conflict",
		});
	});

	it("leaves the duplicate in review when the target refuses the merge", async () => {
		arrangeRows({
			"example-target": row([target], { status: "APPLYING" }),
			"example-source": row([duplicate, other]),
		});

		await expect(mergeDuplicate()).resolves.toEqual({
			outcome: "conflict",
		});
		expect(mocks.create).not.toHaveBeenCalled();
	});

	it("reports conflict when the duplicate's proposal changed under the move", async () => {
		arrangeRows({
			"example-target": row([target]),
			"example-source": row([duplicate, other]),
		});
		mocks.updateMany
			.mockResolvedValueOnce({ count: 1 })
			.mockResolvedValueOnce({ count: 0 });

		await expect(mergeDuplicate()).resolves.toEqual({
			outcome: "conflict",
		});
	});
});
