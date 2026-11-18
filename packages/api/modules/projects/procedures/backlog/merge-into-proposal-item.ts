import { ORPCError } from "@orpc/server";
import {
	canEditProject,
	MERGE_ADDITION_MAX_LENGTH,
	mergeIntoPendingProposalItem,
} from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { PROPOSAL_ALREADY_ACTIONED_MESSAGE } from "./proposal-approval-guards";
import { PROPOSAL_REVIEW_MAX_CHANGES } from "./proposal-review";

/** Refusal when a merge would leave the item's description too long. */
const MERGE_TOO_LONG_MESSAGE =
	"This proposal item is already too long to merge more text into. Create a new item instead.";

/**
 * Merge a manually entered work item into a similar unresolved item of a
 * PENDING Proposal Inbox proposal, instead of creating a second ticket. The
 * entered text is appended to the item's proposed description under a
 * heading naming the manual entry and who added it; the item stays in review
 * for a person to approve, so nothing reaches the Roadmap here.
 *
 * AUTHORIZATION: project edit permission (`PROJECT_UPDATE` plus
 * `canEditProject`), the same bar as the inbox's approve and per-item
 * "Move to Rejected". The write is a compare-and-set on the row, so a
 * proposal another reviewer just actioned returns CONFLICT. The successful
 * call is recorded by the automatic activity audit, with the proposal as
 * its resource (`id` in the result), like the other inbox item actions.
 */
export const mergeIntoProposalItemProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_UPDATE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/backlog/proposals/{proposalId}/merge-item",
		tags: ["Projects", "Backlog"],
		summary: "Merge a manual entry into a pending proposal item",
		description:
			"Appends manually entered work-item text to one unresolved item of a pending Proposal Inbox proposal instead of creating a new work item. The item stays in review.",
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
			description: z
				.string()
				.trim()
				.min(1)
				.max(MERGE_ADDITION_MAX_LENGTH),
		}),
	)
	.output(
		z.object({
			id: z.string(),
			changeIndex: z.number(),
		}),
	)
	.handler(async ({ input, context }) => {
		const user = context.user;
		if (!(await canEditProject(input.projectId, user.id))) {
			throw new ORPCError("FORBIDDEN", {
				message: "You don't have permission to edit this project",
			});
		}

		const result = await mergeIntoPendingProposalItem({
			projectId: input.projectId,
			proposalId: input.proposalId,
			changeIndex: input.changeIndex,
			addition: input.description,
			addedBy: user.name?.trim() || null,
		});
		switch (result.outcome) {
			case "merged":
				return { id: input.proposalId, changeIndex: input.changeIndex };
			case "not_found":
				throw new ORPCError("NOT_FOUND", {
					message: "Proposal not found",
				});
			case "invalid_index":
				throw new ORPCError("BAD_REQUEST", {
					message:
						"This item can no longer take the new text. Re-open the proposal.",
				});
			case "too_long":
				throw new ORPCError("BAD_REQUEST", {
					message: MERGE_TOO_LONG_MESSAGE,
				});
			case "conflict":
				throw new ORPCError("CONFLICT", {
					message: PROPOSAL_ALREADY_ACTIONED_MESSAGE,
				});
			default: {
				const unhandled: never = result;
				throw new Error(
					`Unhandled proposal item merge: ${String(unhandled)}`,
				);
			}
		}
	});
