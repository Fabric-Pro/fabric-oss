/**
 * The Decision Log note a Proposal Inbox review leaves on the ticket an update
 * targeted: the applied changes and why, or that the update was rejected in
 * full. One AGENT-authored entry per (proposal, item, outcome), in the
 * "AI Updates" group, so an apply retry or a repeated request never writes a
 * second one. A Decision Log row only: it never touches the Clean Spec, so it
 * does not trigger PM sync.
 */

import { db } from "../../client";
import {
	createDecisionLogEntry,
	type MaturationTenantFilter,
} from "../feature-maturation";

/**
 * `impactedSection` that groups AGENT change notes as "AI Updates" in the
 * Decision Log; the same literal as the maturation change-note procedure and
 * the web `DecisionLogPanel`.
 */
const AI_UPDATES_SECTION = "AI Updates";

const SOURCE_PROVENANCE = "Proposal review";

type ProposalReviewOutcome = "applied" | "rejected";

interface RecordProposalReviewNoteParams {
	tenantFilter: MaturationTenantFilter;
	userStoryId: string;
	proposalId: string;
	changeIndex: number;
	outcome: ProposalReviewOutcome;
	/** One bullet per line; blank lines are dropped. */
	lines: readonly string[];
	/** The reviewer who applied or rejected the update. */
	authorName?: string | null;
}

/** The key that makes the note idempotent, stored in `metadata`. */
function proposalReviewNoteKey(
	proposalId: string,
	changeIndex: number,
	outcome: ProposalReviewOutcome,
): string {
	return `proposal:${proposalId}:${changeIndex}:${outcome}`;
}

/**
 * Write the note unless one with the same key already exists on the ticket.
 * Returns whether a row was written. Callers treat a failure as best-effort:
 * the review itself has already happened.
 */
export async function recordProposalReviewNote(
	params: RecordProposalReviewNoteParams,
): Promise<{ written: boolean }> {
	const content = params.lines
		.map((line) => line.trim())
		.filter(Boolean)
		.join("\n");
	if (!content) {
		return { written: false };
	}
	const noteKey = proposalReviewNoteKey(
		params.proposalId,
		params.changeIndex,
		params.outcome,
	);
	const existing = await db.decisionLogEntry.findFirst({
		where: {
			userStoryId: params.userStoryId,
			impactedSection: AI_UPDATES_SECTION,
			metadata: { path: ["proposalReviewNoteKey"], equals: noteKey },
		},
		select: { id: true },
	});
	if (existing) {
		return { written: false };
	}
	await createDecisionLogEntry({
		tenantFilter: params.tenantFilter,
		userStoryId: params.userStoryId,
		authorType: "AGENT",
		authorName: params.authorName ?? null,
		sourceProvenance: SOURCE_PROVENANCE,
		status: "RESOLVED",
		source: "AI_CONFIRMED",
		content,
		summary: null,
		impactedSection: AI_UPDATES_SECTION,
		metadata: {
			proposalReviewNoteKey: noteKey,
			proposalId: params.proposalId,
			changeIndex: params.changeIndex,
			outcome: params.outcome,
		},
	});
	return { written: true };
}
