import { ORPCError } from "@orpc/server";
import {
	computeActionItemKey,
	db,
	dismissActionItemLink,
	hasProjectAccess,
	isFeatureEnabled,
	upsertPersonLink,
} from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireInputOrgPermission,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";

/**
 * Add and remove links between a meeting action item and a work item
 * (#1902 FR3/FR4).
 *
 * PROJECT_READ, matching `proposeActionItem`: the card puts link curation in
 * every project member's hands ("All project members with access to the meeting
 * digest can remove or add links"). Neither operation can change work item
 * content — a link is navigational only, per the card's "no auto-updates to
 * existing tickets" decision.
 */

const linkInput = z.object({
	projectId: z.string(),
	organizationId: z.string().nullable().optional(),
});

/** Shared preamble: flag gate, org resolution, project access. */
async function authorize(
	input: { projectId: string; organizationId?: string | null },
	context: { user: { id: string }; session: unknown },
): Promise<{ userId: string; organizationId: string | undefined }> {
	if (!(await isFeatureEnabled("MEETING_ACTION_ITEM_LINKING"))) {
		// NOT_FOUND rather than FORBIDDEN: with the flag off the endpoint does
		// not exist as far as a caller is concerned, and the client never
		// renders a control that reaches it.
		throw new ORPCError("NOT_FOUND", { message: "Not found" });
	}
	const organizationId = resolveOrganizationId(
		input.organizationId,
		context.session as Parameters<typeof resolveOrganizationId>[1],
	);
	const access = await hasProjectAccess(
		input.projectId,
		context.user.id,
		organizationId,
	);
	if (!access) {
		throw new ORPCError("FORBIDDEN", {
			message: "You do not have access to this project",
		});
	}
	return { userId: context.user.id, organizationId };
}

/**
 * FR4: link an action item to a work item by hand.
 *
 * Takes the action item's row id (what the digest renders) and resolves its text
 * to the durable `itemKey` here, so the client never has to know the hashing
 * rule. Re-adding a previously removed pair revives the tombstone — see
 * `upsertPersonLink`.
 */
export const addActionItemLinkProcedure = tenantProtectedProcedure
	.use(requireInputOrgPermission(Permissions.PROJECT_READ))
	.use(requireProjectPermission(Permissions.PROJECT_READ))
	.route({
		method: "POST",
		path: "/projects/{projectId}/meeting-digest/action-items/{actionItemId}/links",
		tags: ["Projects", "Meeting Digest"],
		summary: "Link a meeting action item to a work item",
	})
	.input(
		linkInput.extend({
			actionItemId: z.string(),
			storyId: z.string(),
		}),
	)
	.handler(async ({ input, context }) => {
		const { userId } = await authorize(input, context);

		// Both sides are resolved under the project scope, so neither an action
		// item nor a work item from another project can be linked.
		const [item, story] = await Promise.all([
			db.projectMeetingActionItem.findFirst({
				where: {
					id: input.actionItemId,
					transcript: { projectId: input.projectId },
				},
				select: {
					text: true,
					transcriptId: true,
					// Tenancy is COPIED from the parent transcript rather than
					// derived from the caller's session, exactly as the extraction
					// activity stamps action item rows. A link must sit in the same
					// RLS scope as the meeting it belongs to; deriving it from the
					// request would let a guest's context write a row the meeting's
					// own members cannot read.
					transcript: {
						select: { userId: true, organizationId: true },
					},
				},
			}),
			db.userStory.findFirst({
				where: { id: input.storyId, projectId: input.projectId },
				select: { id: true },
			}),
		]);
		if (!item) {
			throw new ORPCError("NOT_FOUND", {
				message: "Action item not found",
			});
		}
		if (!story) {
			throw new ORPCError("NOT_FOUND", {
				message: "Work item not found",
			});
		}

		const link = await upsertPersonLink({
			transcriptId: item.transcriptId,
			projectId: input.projectId,
			itemKey: computeActionItemKey(item.text),
			itemTextSnapshot: item.text,
			storyId: story.id,
			origin: "MANUAL",
			createdById: userId,
			userId: item.transcript.userId,
			organizationId: item.transcript.organizationId,
		});

		return { linkId: link.id };
	});

/**
 * FR3: remove one link without touching the others on the same action item.
 *
 * Writes a DISMISSED tombstone rather than deleting, so the next matching run
 * cannot re-suggest what the user just rejected.
 */
export const removeActionItemLinkProcedure = tenantProtectedProcedure
	.use(requireInputOrgPermission(Permissions.PROJECT_READ))
	.use(requireProjectPermission(Permissions.PROJECT_READ))
	.route({
		method: "POST",
		path: "/projects/{projectId}/meeting-digest/action-item-links/{linkId}/remove",
		tags: ["Projects", "Meeting Digest"],
		summary: "Remove a link between an action item and a work item",
	})
	.input(linkInput.extend({ linkId: z.string() }))
	.handler(async ({ input, context }) => {
		const { userId } = await authorize(input, context);

		const removed = await dismissActionItemLink({
			linkId: input.linkId,
			projectId: input.projectId,
			dismissedById: userId,
		});
		if (!removed) {
			throw new ORPCError("NOT_FOUND", { message: "Link not found" });
		}

		return { removed: true as const };
	});
