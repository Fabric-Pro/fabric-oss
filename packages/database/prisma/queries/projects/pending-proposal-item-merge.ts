/**
 * Merge a manually entered work item into an unresolved item of a PENDING
 * review-inbox proposal, instead of creating a second ticket for the same
 * work. The entered text is appended to the item's proposed description
 * under a heading that says where it came from; nothing else changes.
 */

import { db, type Prisma } from "../../client";
import {
	proposalItemStateForRow,
	sourceMetadataEquals,
} from "./pending-proposal-item-state";
import {
	asJsonRecord,
	isNewWorkChange,
	readStoredChangeEntry,
	readStoredProposalChange,
} from "./proposal-changes";

export type MergeIntoProposalItemResult =
	| { outcome: "merged" }
	| { outcome: "not_found" }
	| { outcome: "invalid_index" }
	| { outcome: "too_long" }
	| { outcome: "conflict" };

/** Heading above text merged in from the manual create dialog. */
export const MANUAL_ENTRY_HEADING = "Added from a manually entered work item";

/** Heading above another inbox item merged in as a duplicate. */
export const DUPLICATE_ITEM_HEADING = "Merged from a duplicate inbox item";

/** Longest manual entry one merge accepts, in characters. */
export const MERGE_ADDITION_MAX_LENGTH = 10_000;

/** Longest proposed description a merge may leave on an item, in characters. */
export const MERGED_DESCRIPTION_MAX_LENGTH = 20_000;

const toJson = (value: unknown): Prisma.InputJsonValue =>
	JSON.parse(JSON.stringify(value));

/** `existing`, then a rule, then `addition` under an attributed heading. */
export function appendManualEntry(
	existing: string,
	addition: string,
	addedBy: string | null,
	title: string = MANUAL_ENTRY_HEADING,
): string {
	const heading = addedBy ? `${title} (by ${addedBy}):` : `${title}:`;
	const block = `${heading}\n\n${addition.trim()}`;
	const base = existing.trim();
	return base ? `${base}\n\n---\n\n${block}` : block;
}

/**
 * The change with `addition` appended to its proposed description. A
 * captured routing description is extended too, because a routing override
 * re-submits that text instead of the row's body.
 */
export function mergeManualEntryIntoChange(
	change: Record<string, unknown>,
	addition: string,
	addedBy: string | null,
	heading: string = MANUAL_ENTRY_HEADING,
): Record<string, unknown> {
	const merged = appendManualEntry(
		readStoredChangeEntry(change, 0).description,
		addition,
		addedBy,
		heading,
	);
	const description = asJsonRecord(change.description);
	const routing = asJsonRecord(change.routing);
	const capturedDescription = routing?.proposedDescription;
	return {
		...change,
		description: description
			? { ...description, to: merged }
			: { to: merged },
		...(routing && typeof capturedDescription === "string"
			? {
					routing: {
						...routing,
						proposedDescription: appendManualEntry(
							capturedDescription,
							addition,
							addedBy,
							heading,
						),
					},
				}
			: {}),
	};
}

/**
 * Whether a merged change's description, or its captured routing copy, is
 * longer than a merge may leave it.
 */
export function exceedsMergedDescriptionLimit(
	change: Record<string, unknown>,
): boolean {
	const captured = asJsonRecord(change.routing)?.proposedDescription;
	return [
		readStoredChangeEntry(change, 0).description,
		typeof captured === "string" ? captured : "",
	].some((text) => text.length > MERGED_DESCRIPTION_MAX_LENGTH);
}

interface MergeIntoProposalItemParams {
	projectId: string;
	proposalId: string;
	changeIndex: number;
	addition: string;
	addedBy: string | null;
	/** Heading above the addition; the manual entry's by default. */
	heading?: string;
}

/** {@link mergeIntoPendingProposalItem} inside a caller's transaction. */
export async function mergeInTransaction(
	tx: Prisma.TransactionClient,
	params: MergeIntoProposalItemParams,
): Promise<MergeIntoProposalItemResult> {
	const row = await tx.pendingBacklogProposal.findUnique({
		where: { id: params.proposalId },
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
		return { outcome: "not_found" };
	}
	if (row.status !== "PENDING") {
		return { outcome: "conflict" };
	}
	const proposal = asJsonRecord(row.proposal);
	const changes = proposal?.changes;
	const item =
		params.changeIndex < row.changeCount
			? readStoredProposalChange(row.proposal, params.changeIndex)
			: null;
	if (
		!proposal ||
		!Array.isArray(changes) ||
		!item ||
		!isNewWorkChange(item)
	) {
		return { outcome: "invalid_index" };
	}
	const state = await proposalItemStateForRow(params.proposalId, row, tx);
	if (state.resolved.has(params.changeIndex)) {
		return { outcome: "conflict" };
	}

	const mergedItem = mergeManualEntryIntoChange(
		item.raw,
		params.addition,
		params.addedBy,
		params.heading,
	);
	if (exceedsMergedDescriptionLimit(mergedItem)) {
		return { outcome: "too_long" };
	}
	const nextChanges = changes.map((change: unknown, index) =>
		index === params.changeIndex ? mergedItem : change,
	);
	// Compare-and-set on what was read: a concurrent apply, per-item move or
	// second merge changes the status, the proposal or its item ledger, and
	// this write then matches nothing.
	const updated = await tx.pendingBacklogProposal.updateMany({
		where: {
			id: params.proposalId,
			status: "PENDING",
			proposal: { equals: toJson(row.proposal) },
			sourceMetadata: sourceMetadataEquals(row.sourceMetadata),
		},
		data: { proposal: toJson({ ...proposal, changes: nextChanges }) },
	});
	return updated.count === 1
		? { outcome: "merged" }
		: { outcome: "conflict" };
}

/**
 * Append a manual entry to one unresolved create item of a PENDING
 * proposal in `projectId`. Refused as `conflict` when the proposal left
 * review or the item was resolved, as `invalid_index` when the index
 * names no create item, and as `too_long` when the merged description would
 * exceed `MERGED_DESCRIPTION_MAX_LENGTH`.
 */
export async function mergeIntoPendingProposalItem(
	params: MergeIntoProposalItemParams,
): Promise<MergeIntoProposalItemResult> {
	return await db.$transaction((tx) => mergeInTransaction(tx, params));
}
