/**
 * Merge one unresolved review-inbox item into another as its duplicate: the
 * source item's title, description and acceptance criteria are appended to
 * the target item's proposed description under
 * {@link DUPLICATE_ITEM_HEADING}, and the source item moves to Rejected with
 * a note naming the item it was merged into. Both happen in one transaction,
 * so neither is left half done.
 */

import { db } from "../../client";
import {
	DUPLICATE_ITEM_HEADING,
	type MergeIntoProposalItemResult,
	mergeInTransaction,
} from "./pending-proposal-item-merge";
import {
	moveItemInTransaction,
	ProposalItemMoveConflict,
} from "./pending-proposal-item-move";
import { proposalItemStateForRow } from "./pending-proposal-item-state";
import {
	isNewWorkChange,
	proposedAcceptanceCriteria,
	readStoredProposalChange,
	type StoredProposalChange,
} from "./proposal-changes";

export type MergeDuplicateItemResult =
	| MergeIntoProposalItemResult
	/** The source proposal is missing or belongs to another project. */
	| { outcome: "source_not_found" }
	/** The source proposal left review, or its item was already resolved. */
	| { outcome: "source_resolved" }
	/** The source index names no create item. */
	| { outcome: "source_invalid" }
	/** Source and target are the same item. */
	| { outcome: "same_item" };

/**
 * What the Rejected row of a merged duplicate records about the merge. The
 * Rejected list shows `intoItemTitle`, the title of the item it was merged
 * into at the time of the merge.
 */
export type MergedDuplicateNote = {
	kind: "merged_duplicate";
	intoProposalId: string;
	intoChangeIndex: number;
	intoItemTitle: string;
	mergedAt: string;
};

interface ItemRef {
	proposalId: string;
	changeIndex: number;
}

/** Thrown inside the transaction so the target's merge rolls back when the
 * source item could not be moved. */
class DuplicateMergeRollback extends Error {}

/** The text a duplicate item adds to the item it is merged into. */
export function duplicateItemText(change: StoredProposalChange): string {
	const criteria = proposedAcceptanceCriteria(change).trim();
	return [
		change.title.trim(),
		change.description.trim(),
		criteria ? `Acceptance criteria:\n\n${criteria}` : "",
	]
		.filter((part) => part !== "")
		.join("\n\n");
}

/**
 * Merge the unresolved create item `source` into the unresolved create item
 * `target`, both of PENDING proposals in `projectId`, and move `source` to
 * Rejected. Target refusals are those of `mergeIntoPendingProposalItem`; a
 * concurrent change to either proposal reports `conflict` and changes
 * nothing.
 */
export async function mergeDuplicateInboxItem(params: {
	projectId: string;
	source: ItemRef;
	target: ItemRef;
	mergedBy: string;
	mergedByName: string | null;
}): Promise<MergeDuplicateItemResult> {
	const { source, target } = params;
	if (
		source.proposalId === target.proposalId &&
		source.changeIndex === target.changeIndex
	) {
		return { outcome: "same_item" };
	}
	try {
		return await db.$transaction(
			async (tx): Promise<MergeDuplicateItemResult> => {
				const row = await tx.pendingBacklogProposal.findUnique({
					where: { id: source.proposalId },
					select: {
						projectId: true,
						status: true,
						proposal: true,
						changeCount: true,
						appliedChangeIndexes: true,
						sourceMetadata: true,
					},
				});
				if (!row || row.projectId !== params.projectId) {
					return { outcome: "source_not_found" };
				}
				if (row.status !== "PENDING") {
					return { outcome: "source_resolved" };
				}
				const item =
					source.changeIndex < row.changeCount
						? readStoredProposalChange(
								row.proposal,
								source.changeIndex,
							)
						: null;
				if (!item || !isNewWorkChange(item)) {
					return { outcome: "source_invalid" };
				}
				const state = await proposalItemStateForRow(
					source.proposalId,
					row,
					tx,
				);
				if (state.resolved.has(source.changeIndex)) {
					return { outcome: "source_resolved" };
				}

				const merged = await mergeInTransaction(tx, {
					projectId: params.projectId,
					proposalId: target.proposalId,
					changeIndex: target.changeIndex,
					addition: duplicateItemText(item),
					addedBy: params.mergedByName,
					heading: DUPLICATE_ITEM_HEADING,
				});
				if (merged.outcome !== "merged") {
					return merged;
				}
				const into = await tx.pendingBacklogProposal.findUnique({
					where: { id: target.proposalId },
					select: { proposal: true },
				});
				const intoItem = into
					? readStoredProposalChange(
							into.proposal,
							target.changeIndex,
						)
					: null;
				const note: MergedDuplicateNote = {
					kind: "merged_duplicate",
					intoProposalId: target.proposalId,
					intoChangeIndex: target.changeIndex,
					intoItemTitle: intoItem?.title ?? "",
					mergedAt: new Date().toISOString(),
				};
				const moved = await moveItemInTransaction(tx, {
					proposalId: source.proposalId,
					changeIndex: source.changeIndex,
					reviewedBy: params.mergedBy,
					rejectionNote: note,
				});
				if (moved.outcome !== "moved" && moved.outcome !== "split") {
					throw new DuplicateMergeRollback(moved.outcome);
				}
				return { outcome: "merged" };
			},
		);
	} catch (error) {
		if (
			error instanceof ProposalItemMoveConflict ||
			error instanceof DuplicateMergeRollback ||
			isWriteConflict(error)
		) {
			return { outcome: "conflict" };
		}
		throw error;
	}
}

/**
 * Prisma's code for a transaction lost to a write conflict or a deadlock:
 * two reviewers merging two items into each other at once.
 */
function isWriteConflict(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		error.code === "P2034"
	);
}
