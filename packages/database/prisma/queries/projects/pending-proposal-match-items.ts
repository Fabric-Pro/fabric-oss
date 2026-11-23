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
import { extractFocusTexts, type FocusTexts } from "./duplicate-focus";
import { listProposalItemStates } from "./pending-proposal-item-state";
import {
	isNewWorkChange,
	proposedAcceptanceCriteria,
	readStoredProposalChanges,
} from "./proposal-changes";

/** Cap on an item's title as read from the unbounded proposal JSON. */
const ITEM_TITLE_MAX_CHARS = 200;

/**
 * Caps on an item's description and acceptance criteria as read from the
 * proposal JSON. They bound the cost of embedding one item. The opening of a
 * body carries most of its duplicate signal.
 */
const ITEM_DESCRIPTION_MAX_CHARS = 2_000;
const ITEM_ACCEPTANCE_CRITERIA_MAX_CHARS = 1_000;

/** PENDING proposals read per page while collecting items. */
const PROPOSAL_PAGE_SIZE = 50;

export interface PendingProposalMatchItem {
	proposalId: string;
	changeIndex: number;
	source: PendingBacklogProposalSource;
	proposalSummary: string;
	/** When the proposal was captured, for the proximity relaxation. */
	createdAt: Date;
	title: string;
	description: string;
	acceptanceCriteria: string;
	/** A feature's Scope / acceptance-criteria sections; null for a bug. */
	focusTexts: FocusTexts | null;
}

/** The unresolved new-work items of one proposal row, in index order. */
export function unresolvedNewWorkItems(
	row: {
		id: string;
		source: PendingBacklogProposalSource;
		summary: string;
		proposal: unknown;
		changeCount: number;
		createdAt: Date;
	},
	resolved: ReadonlySet<number>,
): PendingProposalMatchItem[] {
	return readStoredProposalChanges(row.proposal)
		.slice(0, row.changeCount)
		.filter(
			(change) => !resolved.has(change.index) && isNewWorkChange(change),
		)
		.map((change) => {
			const acceptanceCriteria = proposedAcceptanceCriteria(change);
			return {
				proposalId: row.id,
				changeIndex: change.index,
				source: row.source,
				proposalSummary: row.summary,
				createdAt: row.createdAt,
				title: change.title.slice(0, ITEM_TITLE_MAX_CHARS),
				description: change.description.slice(
					0,
					ITEM_DESCRIPTION_MAX_CHARS,
				),
				acceptanceCriteria: acceptanceCriteria.slice(
					0,
					ITEM_ACCEPTANCE_CRITERIA_MAX_CHARS,
				),
				// Apply creates every non-bug item as a feature. The sections
				// are read from the whole body, so a Scope section past the
				// description cap still counts; each is capped at the roadmap
				// scan's `MAX_FOCUS_CHARS`.
				focusTexts: extractFocusTexts({
					kind: change.type === "bug" ? "BUG" : "FEATURE",
					description: change.description,
					acceptanceCriteria,
				}),
			};
		});
}

/**
 * Unresolved new-work items across a project's PENDING proposals, newest
 * proposal first; with `maxItems`, only that many. Proposals are read a page
 * at a time, each page strictly after the last row of the one before, until
 * the cap is reached or none are left. A row that changes status between
 * pages moves no boundary, so no other proposal is skipped. Per-item state is
 * read per page in two batched queries rather than two per proposal. Throws
 * once `signal` aborts.
 */
export async function listUnresolvedPendingProposalItems(params: {
	projectId: string;
	maxItems?: number;
	signal?: AbortSignal;
}): Promise<PendingProposalMatchItem[]> {
	const maxItems = params.maxItems ?? Number.POSITIVE_INFINITY;
	const items: PendingProposalMatchItem[] = [];
	let after: { createdAt: Date; id: string } | undefined;
	while (items.length < maxItems) {
		params.signal?.throwIfAborted();
		const rows = await db.pendingBacklogProposal.findMany({
			where: {
				projectId: params.projectId,
				status: "PENDING",
				...(after
					? {
							OR: [
								{ createdAt: { lt: after.createdAt } },
								{
									createdAt: after.createdAt,
									id: { lt: after.id },
								},
							],
						}
					: {}),
			},
			select: {
				id: true,
				source: true,
				summary: true,
				proposal: true,
				changeCount: true,
				appliedChangeIndexes: true,
				sourceMetadata: true,
				createdAt: true,
			},
			orderBy: [{ createdAt: "desc" }, { id: "desc" }],
			take: PROPOSAL_PAGE_SIZE,
		});
		const last = rows.at(-1);
		if (!last) {
			break;
		}
		const states = await listProposalItemStates(rows);
		items.push(
			...rows.flatMap((row, index) =>
				unresolvedNewWorkItems(row, states[index].resolved),
			),
		);
		if (rows.length < PROPOSAL_PAGE_SIZE) {
			break;
		}
		after = { createdAt: last.createdAt, id: last.id };
	}
	return items.slice(0, maxItems);
}
