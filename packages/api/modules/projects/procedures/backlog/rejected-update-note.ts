import {
	db,
	type MaturationTenantFilter,
	readStoredProposalChange,
	recordProposalReviewNote,
} from "@repo/database";
import { logger } from "@repo/logs";
import { proposalUpdateRejectedNoteLines } from "@repo/utils/proposal-update-summary";

/**
 * After a reviewer rejected every change of a proposed update (Thorough
 * review in the Proposal Inbox) and the item moved to Rejected, note on the
 * target ticket that it was reviewed and nothing was applied.
 *
 * Only for an update whose target is a ticket of the proposal's own project.
 * Best-effort: the item has already moved, so a failed note is logged, not
 * thrown. Idempotent: a repeated request finds the earlier note.
 */
export async function noteRejectedProposalUpdate(params: {
	proposal: { id: string; projectId: string; proposal: unknown };
	changeIndex: number;
	tenantFilter: MaturationTenantFilter;
	reviewerName: string | null;
}): Promise<void> {
	const item = readStoredProposalChange(
		params.proposal.proposal,
		params.changeIndex,
	);
	if (item?.action !== "update" || !item.existingId) {
		return;
	}
	try {
		const story = await db.userStory.findFirst({
			where: {
				id: item.existingId,
				projectId: params.proposal.projectId,
			},
			select: { id: true },
		});
		if (!story) {
			return;
		}
		await recordProposalReviewNote({
			tenantFilter: params.tenantFilter,
			userStoryId: story.id,
			proposalId: params.proposal.id,
			changeIndex: params.changeIndex,
			outcome: "rejected",
			lines: proposalUpdateRejectedNoteLines({
				reasoning: item.reasoning,
			}),
			authorName: params.reviewerName,
		});
	} catch (error) {
		logger.warn("Failed to note a fully rejected proposal update", {
			proposalId: params.proposal.id,
			changeIndex: params.changeIndex,
			error: error instanceof Error ? error.message : String(error),
		});
	}
}
