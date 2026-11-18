/**
 * Unresolved new-work items of PENDING review-inbox proposals, read for
 * duplicate matching: a manually entered work item against the inbox, and
 * the inbox's items against the Roadmap and each other.
 *
 * Only create items take part. An update already names the ticket it
 * changes, so it is never a duplicate candidate of its own.
 */

import { db } from "../../client";
import type { PendingBacklogProposalSource } from "../../generated/enums";
import { listProposalItemStates } from "./pending-proposal-item-state";
import { isNewWorkChange, readStoredProposalChanges } from "./proposal-changes";

/** Cap on an item's title as read from the unbounded proposal JSON. */
const ITEM_TITLE_MAX_CHARS = 200;

/**
 * Cap on an item's description as read from the proposal JSON. Inbox items
 * are embedded fresh on every check (they have no embedding cache), so this
 * bounds the cost of one check: about 150 items of at most ~2,200 characters
 * each. The opening of a description carries most of its duplicate signal.
 */
const ITEM_DESCRIPTION_MAX_CHARS = 2_000;

/** Newest PENDING proposals read for one request when no cap is given. */
const DEFAULT_MAX_PROPOSALS = 50;

export interface PendingProposalMatchItem {
	proposalId: string;
	changeIndex: number;
	source: PendingBacklogProposalSource;
	proposalSummary: string;
	title: string;
	description: string;
}

/** The unresolved new-work items of one proposal row, in index order. */
export function unresolvedNewWorkItems(
	row: {
		id: string;
		source: PendingBacklogProposalSource;
		summary: string;
		proposal: unknown;
		changeCount: number;
	},
	resolved: ReadonlySet<number>,
): PendingProposalMatchItem[] {
	return readStoredProposalChanges(row.proposal)
		.slice(0, row.changeCount)
		.filter(
			(change) => !resolved.has(change.index) && isNewWorkChange(change),
		)
		.map((change) => ({
			proposalId: row.id,
			changeIndex: change.index,
			source: row.source,
			proposalSummary: row.summary,
			title: change.title.slice(0, ITEM_TITLE_MAX_CHARS),
			description: change.description.slice(
				0,
				ITEM_DESCRIPTION_MAX_CHARS,
			),
		}));
}

/**
 * Unresolved new-work items across a project's PENDING proposals, newest
 * proposal first, capped at `maxItems`. Per-item state is read for every
 * proposal in two batched queries rather than two per proposal.
 */
export async function listUnresolvedPendingProposalItems(params: {
	projectId: string;
	maxItems: number;
	maxProposals?: number;
}): Promise<PendingProposalMatchItem[]> {
	const rows = await db.pendingBacklogProposal.findMany({
		where: { projectId: params.projectId, status: "PENDING" },
		select: {
			id: true,
			source: true,
			summary: true,
			proposal: true,
			changeCount: true,
			appliedChangeIndexes: true,
			sourceMetadata: true,
		},
		orderBy: { createdAt: "desc" },
		take: params.maxProposals ?? DEFAULT_MAX_PROPOSALS,
	});
	const states = await listProposalItemStates(rows);
	return rows
		.flatMap((row, index) =>
			unresolvedNewWorkItems(row, states[index].resolved),
		)
		.slice(0, params.maxItems);
}
