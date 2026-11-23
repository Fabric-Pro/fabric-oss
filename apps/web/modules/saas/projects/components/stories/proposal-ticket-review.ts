/**
 * Thorough review of a Proposal Inbox update on the ticket it updates.
 *
 * "Review line by line" in the inbox hands the item, as the reviewer left
 * it, to the ticket page, which shows the proposed changes in the editor as
 * a pending review: the same per-change accept / reject the AI assistant's
 * edits get. Only what the reviewer accepted is approved, through the same
 * door the inbox approves with; Reject all moves the item to Rejected and
 * notes the review on the ticket.
 *
 * The hand-off is kept in memory and in the tab's `sessionStorage`, so the
 * review survives a reload of the ticket page, with the item exactly as the
 * reviewer left it (a re-routed item and edited fields included, which the
 * stored proposal does not hold). It is per tab and ends with the browser
 * session. A stale hand-off cannot apply stale text: the approval carries
 * the proposal revision it was started from, and the server refuses it once
 * the proposal changed.
 */

import { ownEditBodies } from "@repo/utils/proposal-update-edits";
import { summarizeProposalUpdate } from "@repo/utils/proposal-update-summary";
import { type Editor, getHTMLFromFragment } from "@tiptap/core";
import { z } from "zod";
import { documentWithoutUndecidedChanges } from "../../lib/editor-diff-marks";
import { getEditorMarkdownForSave } from "../../lib/editor-markdown-save";
import type { ChangeItem } from "./BacklogChangeProposal";
import type { ProposalPmConfig } from "./proposal-inbox-client";

type PmSyncOverride = { pushAnyway?: boolean; skip?: boolean };

/** One inbox update, on its way to a review on its ticket. */
export type ProposalTicketReview = {
	projectId: string;
	organizationId: string | null;
	/** The ticket the update targets. */
	storyId: string;
	proposalId: string;
	source: string;
	changeIndex: number;
	/** The update as the reviewer left it in the inbox. */
	change: ChangeItem;
	syncToPM: boolean;
	pmSyncOverrides?: Record<number, PmSyncOverride>;
	pmConfig?: ProposalPmConfig;
	expectedProposalRevision?: string;
	/** When the review was handed over, in epoch milliseconds. */
	startedAt: number;
};

/** How long a hand-off waits to be resumed before it is dropped. */
export const PROPOSAL_TICKET_REVIEW_TTL_MS = 30 * 60_000;

/** Per tab: a review started in one tab never opens in another. */
export const PROPOSAL_TICKET_REVIEW_STORAGE_KEY = "fabric.proposalTicketReview";

/** What a stored hand-off must hold to be resumed; anything else is dropped. */
const storedReviewSchema = z.object({
	projectId: z.string(),
	organizationId: z.string().nullable(),
	storyId: z.string(),
	proposalId: z.string(),
	source: z.string(),
	changeIndex: z.number().int().min(0),
	change: z.custom<ChangeItem>(
		(value) =>
			typeof value === "object" &&
			value !== null &&
			"action" in value &&
			"title" in value,
	),
	syncToPM: z.boolean(),
	pmSyncOverrides: z
		.record(
			z.string(),
			z.object({
				pushAnyway: z.boolean().optional(),
				skip: z.boolean().optional(),
			}),
		)
		.optional(),
	pmConfig: z
		.object({
			mcpConfigId: z.string(),
			containerId: z.string(),
			additionalContext: z.record(z.string(), z.string()).optional(),
		})
		.optional(),
	expectedProposalRevision: z.string().optional(),
	startedAt: z.number(),
});

let pendingReview: ProposalTicketReview | null = null;

function readStoredReview(): ProposalTicketReview | null {
	if (typeof window === "undefined") {
		return null;
	}
	try {
		const raw = window.sessionStorage.getItem(
			PROPOSAL_TICKET_REVIEW_STORAGE_KEY,
		);
		if (!raw) {
			return null;
		}
		const parsed = storedReviewSchema.safeParse(JSON.parse(raw));
		return parsed.success ? parsed.data : null;
	} catch {
		// An unavailable or corrupt store means no review to resume.
		return null;
	}
}

function writeStoredReview(review: ProposalTicketReview | null): void {
	if (typeof window === "undefined") {
		return;
	}
	try {
		if (review) {
			window.sessionStorage.setItem(
				PROPOSAL_TICKET_REVIEW_STORAGE_KEY,
				JSON.stringify(review),
			);
		} else {
			window.sessionStorage.removeItem(
				PROPOSAL_TICKET_REVIEW_STORAGE_KEY,
			);
		}
	} catch {
		// Private mode or a full quota: the review still works until a reload.
	}
}

/** Hand an update to its ticket page for review. */
export function startProposalTicketReview(
	review: Omit<ProposalTicketReview, "startedAt">,
): void {
	pendingReview = { ...review, startedAt: Date.now() };
	writeStoredReview(pendingReview);
}

/**
 * The update waiting for review on this ticket, if any, also after a reload
 * of the tab. A hand-off older than {@link PROPOSAL_TICKET_REVIEW_TTL_MS} is
 * dropped.
 */
export function pendingProposalTicketReview(
	storyId: string,
): ProposalTicketReview | null {
	pendingReview ??= readStoredReview();
	if (
		pendingReview &&
		Date.now() - pendingReview.startedAt > PROPOSAL_TICKET_REVIEW_TTL_MS
	) {
		endProposalTicketReview();
		return null;
	}
	return pendingReview?.storyId === storyId ? pendingReview : null;
}

/**
 * Whether a handed-over item can still be reviewed: its proposal is in
 * review and the item is not resolved yet.
 */
export function proposalItemStillOpen(
	proposal: {
		status: string;
		resolvedItems: readonly { changeIndex: number }[];
	} | null,
	changeIndex: number,
): boolean {
	return (
		proposal?.status === "PENDING" &&
		!proposal.resolvedItems.some((item) => item.changeIndex === changeIndex)
	);
}

/** The review was applied, rejected or cancelled. */
export function endProposalTicketReview(): void {
	pendingReview = null;
	writeStoredReview(null);
}

/**
 * The document Apply writes: what the editor would hold once every change
 * the reviewer has not accepted is taken back, so an undecided change is
 * never written. Read without changing the editor: a refused or failed
 * Apply leaves every undecided change in place. Null when the editor cannot
 * be read.
 */
export function acceptedTicketDocument(editor: Editor): string | null {
	const accepted = documentWithoutUndecidedChanges(editor);
	return getEditorMarkdownForSave({
		getHTML: () => getHTMLFromFragment(accepted.content, editor.schema),
	});
}

/** The description and acceptance criteria of a ticket. */
export type TicketBodies = { description: string; acceptanceCriteria: string };

function sameBody(a: string, b: string): boolean {
	const normalize = (text: string) => text.replace(/\r\n/g, "\n").trim();
	return normalize(a) === normalize(b);
}

/**
 * The bodies the update writes, when its own text already is that: an
 * update merged into the ticket's structure against the text the ticket
 * still has, or a whole version of the ticket's body written against it
 * (`ownEditBodies`). The review then shows the update's own edits and
 * nothing else. Null when the update must first be merged into the ticket
 * as it is now, which the page reads before the review starts.
 */
export function proposedBodiesAsIs(
	change: ChangeItem,
	current: TicketBodies,
): TicketBodies | null {
	const fields = ["description", "acceptanceCriteria"] as const;
	const moved = fields.filter((field) => {
		const value = change[field];
		return !!value?.to && value.to !== (value.from ?? "");
	});
	const mergedAgainstCurrent =
		change.structurePreserved === true &&
		change.bodyMergeDeferred !== true &&
		change.bodyMergeFallback !== true &&
		moved.every((field) =>
			sameBody(change[field]?.from ?? "", current[field]),
		);
	if (moved.length > 0 && !mergedAgainstCurrent) {
		return ownEditBodies(change, current);
	}
	return {
		description: moved.includes("description")
			? (change.description?.to ?? current.description)
			: current.description,
		acceptanceCriteria: moved.includes("acceptanceCriteria")
			? (change.acceptanceCriteria?.to ?? current.acceptanceCriteria)
			: current.acceptanceCriteria,
	};
}

/**
 * The update to approve after the review: the bodies as the reviewer left
 * them in the editor, against the ticket's stored text, and the item's other
 * fields as they came from the inbox. A body the review left as it was is
 * not written. Null when the review left nothing to change, which rejects
 * the item.
 *
 * `reviewed` and `unchanged` are both read from the review's editor, the
 * way Apply writes it: `unchanged` with every change rejected, so a body
 * equal to it was left alone, whatever the editor's reading does to its
 * text. The item's other fields go with an accepted body change, or once
 * the reviewer answered every body change (`undecidedBodyChanges` is
 * false): an Apply with nothing decided writes nothing, and one after
 * every body change was rejected writes the fields alone.
 */
export function reviewedTicketChange(params: {
	change: ChangeItem;
	stored: TicketBodies;
	unchanged: TicketBodies;
	reviewed: TicketBodies;
	undecidedBodyChanges: boolean;
}): ChangeItem | null {
	const { change, stored, unchanged, reviewed, undecidedBodyChanges } =
		params;
	const body = (field: keyof TicketBodies) =>
		sameBody(reviewed[field], unchanged[field])
			? undefined
			: { from: stored[field], to: reviewed[field] };
	const description = body("description");
	const acceptanceCriteria = body("acceptanceCriteria");
	if (undecidedBodyChanges && !description && !acceptanceCriteria) {
		return null;
	}
	const next: ChangeItem = {
		...change,
		description,
		acceptanceCriteria,
		structurePreserved: true,
		bodyMergeDeferred: undefined,
		bodyMergeFallback: undefined,
	};
	return summarizeProposalUpdate(next).length > 0 ? next : null;
}
