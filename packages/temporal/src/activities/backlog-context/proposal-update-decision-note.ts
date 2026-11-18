/**
 * After a reviewed proposal updates an existing ticket, leave one Decision Log
 * note on that ticket: what the update changed, as written, and why it was
 * proposed. Best-effort: the update has already been saved, so a failed note
 * is logged and the apply continues. Idempotent across activity retries (the
 * note is keyed by proposal and item).
 */

import { recordProposalReviewNote } from "@repo/database";
import { logger } from "@repo/logs";
import {
	type ProposalUpdateFields,
	proposalUpdateAppliedNoteLines,
} from "@repo/utils/proposal-update-summary";

type AppliedUpdateNoteParams = {
	proposalId: string;
	changeIndex: number;
	storyId: string;
	projectId: string;
	organizationId?: string;
	userId: string;
	approvedByName?: string | null;
	/** The fields as written: `from` is the row before, `to` what was saved. */
	applied: ProposalUpdateFields;
	reasoning?: string | null;
	proposal: { source: string; summary: string } | null;
};

/**
 * The fields an update actually wrote, as before/after pairs: bodies against
 * the row as loaded (apply may have merged them into a different text than
 * the proposal's `to`), title/priority/size as proposed. A field the update
 * left alone is absent.
 */
export function appliedUpdateFields(
	change: ProposalUpdateFields,
	written: {
		title?: string;
		description?: string;
		acceptanceCriteria?: string;
		priority?: string;
		size?: string;
	},
	before: {
		title: string;
		description: string | null;
		acceptanceCriteria: string | null;
	} | null,
): ProposalUpdateFields {
	const body = (
		field: "description" | "acceptanceCriteria",
		to: string | undefined,
	) =>
		to === undefined
			? null
			: {
					from: before
						? (before[field] ?? "")
						: (change[field]?.from ?? ""),
					to,
				};
	return {
		title:
			written.title === undefined
				? null
				: {
						from: before?.title ?? change.title?.from,
						to: written.title,
					},
		description: body("description", written.description),
		acceptanceCriteria: body(
			"acceptanceCriteria",
			written.acceptanceCriteria,
		),
		priority: written.priority === undefined ? null : change.priority,
		size: written.size === undefined ? null : change.size,
	};
}

export async function noteAppliedProposalUpdate(
	params: AppliedUpdateNoteParams,
): Promise<void> {
	const lines = proposalUpdateAppliedNoteLines(params.applied, {
		reasoning: params.reasoning,
		source: params.proposal?.source,
		proposalSummary: params.proposal?.summary,
	});
	if (lines.length === 0) {
		return;
	}
	try {
		await recordProposalReviewNote({
			tenantFilter: params.organizationId
				? {
						organizationId: params.organizationId,
						userId: params.userId,
					}
				: { organizationId: null, userId: params.userId },
			userStoryId: params.storyId,
			proposalId: params.proposalId,
			changeIndex: params.changeIndex,
			outcome: "applied",
			lines,
			authorName: params.approvedByName ?? null,
		});
	} catch (error) {
		logger.warn(
			"[Backlog Apply] Failed to write the update's Decision Log note",
			{
				projectId: params.projectId,
				proposalId: params.proposalId,
				changeIndex: params.changeIndex,
				storyId: params.storyId,
				error: error instanceof Error ? error.message : String(error),
			},
		);
	}
}
