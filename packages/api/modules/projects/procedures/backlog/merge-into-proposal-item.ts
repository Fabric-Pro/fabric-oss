import { ORPCError } from "@orpc/server";
import {
	canEditProject,
	MERGE_ADDITION_MAX_LENGTH,
	mergeDuplicateInboxItem,
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

/** Refusals of a merge whose source is another inbox item. */
const SOURCE_NOT_FOUND_MESSAGE = "The duplicate item was not found.";
const SOURCE_RESOLVED_MESSAGE =
	"The duplicate item was already approved or moved to Rejected. Refresh the inbox.";
const SOURCE_INVALID_MESSAGE =
	"Only a proposed new ticket can be merged into another item.";
const SAME_ITEM_MESSAGE = "An item cannot be merged into itself.";

/**
 * Merge text into a similar unresolved item of a PENDING Proposal Inbox
 * proposal, instead of creating a second ticket. The text is either
 *
 * - `description`: a manually entered work item, appended under a heading
 *   naming the manual entry and who added it; or
 * - `source`: another unresolved new item of a PENDING proposal in the same
 *   project, flagged as a duplicate. The server reads its text, appends it
 *   under "Merged from a duplicate inbox item", and moves the source item to
 *   Rejected with a note naming this item, in one transaction.
 *
 * The target item stays in review for a person to approve, so nothing
 * reaches the Roadmap here.
 *
 * AUTHORIZATION: project edit permission (`PROJECT_UPDATE` plus
 * `canEditProject`), the same bar as the inbox's approve and per-item
 * "Move to Rejected". Both proposals must belong to `projectId`; the source
 * is read on the server, never taken from the caller. The writes are
 * compare-and-sets on the rows, so a proposal another reviewer just actioned
 * returns CONFLICT. The successful call is recorded by the automatic
 * activity audit, with the target proposal as its resource (`id` in the
 * result), like the other inbox item actions.
 */
export const mergeIntoProposalItemProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_UPDATE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/backlog/proposals/{proposalId}/merge-item",
		tags: ["Projects", "Backlog"],
		summary:
			"Merge a manual entry or a duplicate item into a pending proposal item",
		description:
			"Appends manually entered work-item text, or another unresolved inbox item flagged as a duplicate, to one unresolved item of a pending Proposal Inbox proposal instead of creating a new work item. A merged inbox item moves to Rejected. The target item stays in review.",
	})
	.input(
		z
			.object({
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
					.max(MERGE_ADDITION_MAX_LENGTH)
					.optional(),
				source: z
					.object({
						proposalId: z.string(),
						changeIndex: z
							.number()
							.int()
							.min(0)
							.max(PROPOSAL_REVIEW_MAX_CHANGES),
					})
					.optional(),
			})
			.refine(
				(input) =>
					(input.description === undefined) !==
					(input.source === undefined),
				{ message: "Send either a description or a source item." },
			),
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

		const addedBy = user.name?.trim() || null;
		const result = input.source
			? await mergeDuplicateInboxItem({
					projectId: input.projectId,
					source: input.source,
					target: {
						proposalId: input.proposalId,
						changeIndex: input.changeIndex,
					},
					mergedBy: user.id,
					mergedByName: addedBy,
				})
			: await mergeIntoPendingProposalItem({
					projectId: input.projectId,
					proposalId: input.proposalId,
					changeIndex: input.changeIndex,
					addition: input.description ?? "",
					addedBy,
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
			case "source_not_found":
				throw new ORPCError("NOT_FOUND", {
					message: SOURCE_NOT_FOUND_MESSAGE,
				});
			case "source_resolved":
				throw new ORPCError("CONFLICT", {
					message: SOURCE_RESOLVED_MESSAGE,
				});
			case "source_invalid":
				throw new ORPCError("BAD_REQUEST", {
					message: SOURCE_INVALID_MESSAGE,
				});
			case "same_item":
				throw new ORPCError("BAD_REQUEST", {
					message: SAME_ITEM_MESSAGE,
				});
			default: {
				const unhandled: never = result;
				throw new Error(
					`Unhandled proposal item merge: ${String(unhandled)}`,
				);
			}
		}
	});
