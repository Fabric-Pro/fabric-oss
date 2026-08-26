import { ORPCError } from "@orpc/server";
import {
	db,
	hasProjectAccess,
	isFeatureEnabled,
	listMeetingReferencesForStory,
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
 * #1902 FR5/FR6: the meetings whose action items reference this work item.
 *
 * `transcriptRef` in each row is the Graph transcript id (NOT the transcript row
 * cuid) because that is what the digest's deep link resolves — the two are
 * routinely confused, so they are named differently everywhere in this feature.
 *
 * `itemText` is the snapshot taken when the link was made, not a live read: an
 * action item's text can change under a re-extraction, and a back-reference
 * showing what was actually agreed at the time is more useful than one that
 * silently rewrites itself (and more honest than one that vanishes).
 */
export const listMeetingReferencesProcedure = tenantProtectedProcedure
	.use(requireInputOrgPermission(Permissions.PROJECT_READ))
	.use(requireProjectPermission(Permissions.PROJECT_READ))
	.route({
		method: "GET",
		path: "/projects/{projectId}/stories/{storyId}/meeting-references",
		tags: ["Projects", "Stories"],
		summary: "List meeting action items referencing this work item",
	})
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
			storyId: z.string(),
		}),
	)
	.handler(async ({ input, context }) => {
		const user = context.user;
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		const access = await hasProjectAccess(
			input.projectId,
			user.id,
			organizationId,
		);
		if (!access) {
			throw new ORPCError("FORBIDDEN", {
				message: "You do not have access to this project",
			});
		}

		// Resolve the story under the project scope BEFORE reading links, so a
		// story id from another project is unfindable rather than merely
		// unauthorized.
		const story = await db.userStory.findFirst({
			where: { id: input.storyId, projectId: input.projectId },
			select: { id: true },
		});
		if (!story) {
			throw new ORPCError("NOT_FOUND", {
				message: "Work item not found",
			});
		}

		// Flag off returns an empty list rather than an error: stored links stay
		// in the database untouched and simply stop rendering (clean rollback).
		if (!(await isFeatureEnabled("MEETING_ACTION_ITEM_LINKING"))) {
			return { references: [] };
		}

		return { references: await listMeetingReferencesForStory(story.id) };
	});
