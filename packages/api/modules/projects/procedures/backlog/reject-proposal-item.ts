import { ORPCError } from "@orpc/server";
import {
	canEditProject,
	getPendingBacklogProposal,
	movePendingProposalItemToBacklog,
} from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import {
	PROPOSAL_ALREADY_ACTIONED_MESSAGE,
	PROPOSAL_CHANGED_MESSAGE,
} from "./proposal-approval-guards";
import { PROPOSAL_REVIEW_MAX_CHANGES } from "./proposal-review";
import { noteRejectedProposalUpdate } from "./rejected-update-note";

/**
 * Move one item of a Proposal Inbox proposal to Rejected, leaving its other
 * items in review. Works on PENDING proposals and on FAILED ones, whose
 * failed item stays behind for Review & retry.
 *
 * The item moves into its own Rejected row (`splitProposalId`), unless it is
 * the proposal's only undecided item, in which case the whole proposal moves.
 * With `noteRejectedUpdate` (the reviewer rejected every change of an update
 * line by line), the target ticket's Decision Log records that review.
 *
 * AUTHORIZATION: project edit permission (`PROJECT_UPDATE` plus
 * `canEditProject`), the same bar as approving the proposal. The move is a
 * compare-and-set, so an item another reviewer resolved returns CONFLICT,
 * and so does a proposal that changed after it was opened.
 */
export const rejectProposalItemProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_UPDATE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/backlog/proposals/{proposalId}/reject-item",
		tags: ["Projects", "Backlog"],
		summary: "Move one item of a pending proposal to Rejected",
		description:
			"Moves one item of a pending or failed Proposal Inbox proposal to Rejected, keeping the other items in review.",
	})
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
			proposalId: z.string(),
			changeIndex: z
				.number()
				.int()
				.min(0)
				.max(PROPOSAL_REVIEW_MAX_CHANGES),
			noteRejectedUpdate: z.boolean().optional(),
		}),
	)
	.output(
		z.object({
			success: z.literal(true),
			updated: z.literal(true),
			/** The new Rejected row holding the item, when it was split out. */
			splitProposalId: z.string().optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const user = context.user;
		if (!(await canEditProject(input.projectId, user.id))) {
			throw new ORPCError("FORBIDDEN", {
				message: "You don't have permission to edit this project",
			});
		}

		const proposal = await getPendingBacklogProposal(input.proposalId);
		if (!proposal || proposal.projectId !== input.projectId) {
			throw new ORPCError("NOT_FOUND", {
				message: "Proposal not found",
			});
		}

		const result = await movePendingProposalItemToBacklog({
			proposalId: input.proposalId,
			changeIndex: input.changeIndex,
			reviewedBy: user.id,
		});
		switch (result.outcome) {
			case "moved":
			case "split":
				break;
			case "invalid_index":
				throw new ORPCError("BAD_REQUEST", {
					message:
						"This item is no longer part of the proposal. Re-open the proposal.",
				});
			case "already_resolved":
				throw new ORPCError("CONFLICT", {
					message: PROPOSAL_ALREADY_ACTIONED_MESSAGE,
				});
			case "proposal_changed":
				throw new ORPCError("CONFLICT", {
					message: PROPOSAL_CHANGED_MESSAGE,
				});
			default: {
				const unhandled: never = result;
				throw new Error(
					`Unhandled proposal item move: ${String(unhandled)}`,
				);
			}
		}

		if (input.noteRejectedUpdate) {
			// The tenant comes from the loaded proposal, never from the
			// caller's input.
			await noteRejectedProposalUpdate({
				proposal,
				changeIndex: input.changeIndex,
				tenantFilter: {
					organizationId: proposal.organizationId ?? null,
					userId: user.id,
				},
				reviewerName: user.name,
			});
		}
		return result.outcome === "split"
			? {
					success: true as const,
					updated: true as const,
					splitProposalId: result.splitProposalId,
				}
			: { success: true as const, updated: true as const };
	});
