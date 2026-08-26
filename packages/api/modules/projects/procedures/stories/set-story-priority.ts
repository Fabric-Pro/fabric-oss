import { ORPCError } from "@orpc/client";
import { applyPriorityChanges, db, type StoryPriority } from "@repo/database";
import { z } from "zod";
import { recordAuditFromRequest } from "../../../../lib/audit";
import {
	Permissions,
	requireInputOrgPermission,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";

/**
 * Maximum length of the optional comment a person can attach to a manual
 * priority change. Long enough for a sentence of justification, short enough
 * that the history stays skimmable — the field is a note, not a discussion.
 */
const MAX_COMMENT_LENGTH = 500;

/**
 * Set one work item's priority band by hand, optionally with a comment.
 *
 * Distinct from the generic `stories.update` mutation on purpose: this is the
 * Priority view's dedicated write path, so it carries the comment, and it
 * routes through `applyPriorityChanges` — which is what guarantees a history
 * row exists for the move. Setting the band to its current value is a no-op:
 * it writes nothing and records nothing, matching the AI path's rule that the
 * history tracks movement rather than intent.
 */
export const setStoryPriorityProcedure = tenantProtectedProcedure
	// `resolveOrganizationId` returns the caller's string as-is, and
	// `requireProjectPermission` resolves on (projectId, userId) without ever
	// reading the org — so without this a caller could pair their own project
	// with someone else's organization id. Asserts membership of the org being
	// written to (SOC 2 CC6.1/CC6.3).
	.use(requireInputOrgPermission(Permissions.STORY_UPDATE))
	.use(requireProjectPermission(Permissions.STORY_UPDATE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/stories/{storyId}/priority",
		tags: ["Projects", "Stories"],
		summary: "Set a work item's priority band",
		description:
			"Manually sets one story's priority, recording a history entry with the actor and an optional comment. A no-op when the band is unchanged.",
	})
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
			storyId: z.string(),
			priority: z.enum(["P0_CRITICAL", "P1_HIGH", "P2_MEDIUM", "P3_LOW"]),
			comment: z.string().max(MAX_COMMENT_LENGTH).optional(),
		}),
	)
	.output(
		z.object({
			changed: z.boolean(),
			priority: z.string(),
			priorityChangedAt: z.date().nullable(),
		}),
	)
	.handler(async ({ input, context }) => {
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		// requireProjectPermission has authorised the project; this confirms the
		// story belongs to it, so a story id from another tenant's project can't
		// be written through a project the caller legitimately holds.
		const story = await db.userStory.findFirst({
			where: { id: input.storyId, projectId: input.projectId },
			select: { id: true, identifier: true, title: true },
		});
		if (!story) {
			throw new ORPCError("NOT_FOUND", { message: "Story not found" });
		}

		const [applied] = await applyPriorityChanges(
			input.projectId,
			[
				{
					storyId: input.storyId,
					toPriority: input.priority as StoryPriority,
					reason: input.comment,
				},
			],
			"MANUAL",
			{ id: context.user.id, name: context.user.name ?? null },
		);

		if (!applied) {
			// Unchanged band — nothing written, nothing logged.
			return {
				changed: false,
				priority: input.priority,
				priorityChangedAt: null,
			};
		}

		recordAuditFromRequest(context, {
			action: "story.updated",
			category: "story",
			organizationId,
			projectId: input.projectId,
			resource: { type: "story", id: story.id, name: story.title },
			metadata: {
				changedFields: ["priority"],
				via: "priority-manual",
				identifier: story.identifier,
				from: applied.fromPriority,
				to: applied.toPriority,
				hasComment: Boolean(input.comment?.trim()),
			},
		});

		const updated = await db.userStory.findUnique({
			where: { id: input.storyId },
			select: { priorityChangedAt: true },
		});

		return {
			changed: true,
			priority: applied.toPriority,
			priorityChangedAt: updated?.priorityChangedAt ?? null,
		};
	});
