import { ORPCError } from "@orpc/client";
import { db, listStoryPriorityHistory } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireInputOrgPermission,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";

/**
 * Default page size, matching the roadmap's other history surfaces so the
 * pager behaves identically wherever a reader meets one.
 */
const DEFAULT_LIMIT = 20;

/** Mirrors the StoryPriority enum. */
const PRIORITY_SCHEMA = z.enum([
	"P0_CRITICAL",
	"P1_HIGH",
	"P2_MEDIUM",
	"P3_LOW",
]);

/**
 * `projects.stories.priorityHistory` — one work item's priority-band trail.
 *
 * Read-only, newest first, cursor-paginated. Fetched lazily when a row in the
 * Priority view is expanded rather than with the list itself: a project with
 * hundreds of items would otherwise pay for history nobody opened, and the
 * list's own "last changed" stamp comes from the denormalised
 * `UserStory.priorityChangedAt` instead.
 *
 * Gated on STORY_READ — a change trail exposes no more than the priority field
 * it describes, which every project reader can already see.
 */
export const priorityHistoryProcedure = tenantProtectedProcedure
	// Defence in depth: the handler derives everything from (projectId,
	// storyId), but the input still carries an organizationId, and every other
	// story procedure that accepts one asserts membership of it.
	.use(requireInputOrgPermission(Permissions.STORY_READ))
	.use(requireProjectPermission(Permissions.STORY_READ))
	.route({
		method: "GET",
		path: "/projects/{projectId}/stories/{storyId}/priority-history",
		tags: ["Projects", "Stories"],
		summary: "List a work item's priority change history",
		description:
			"Read-only trail of priority-band changes for one story, newest first, cursor-paginated. Only real band moves appear — a re-prioritization that left the band alone writes no entry.",
	})
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
			storyId: z.string(),
			cursor: z.string().optional(),
			limit: z.number().int().min(1).max(100).optional(),
		}),
	)
	.output(
		z.object({
			items: z.array(
				z.object({
					id: z.string(),
					// Enums rather than plain strings so the client renders each
					// band through the shared label helper without a cast.
					fromPriority: PRIORITY_SCHEMA.nullable(),
					toPriority: PRIORITY_SCHEMA,
					source: z.enum(["AI", "MANUAL"]),
					reason: z.string().nullable(),
					actorId: z.string().nullable(),
					actorName: z.string().nullable(),
					actorImage: z.string().nullable(),
					createdAt: z.date(),
				}),
			),
			nextCursor: z.string().nullable(),
			/** The band the item was created with; null when it never moved. */
			initialPriority: PRIORITY_SCHEMA.nullable(),
			totalCount: z.number(),
		}),
	)
	.handler(async ({ input }) => {
		// Confirm the story lives in the authorised project before reading its
		// trail — the project permission does not by itself vouch for the id.
		const story = await db.userStory.findFirst({
			where: { id: input.storyId, projectId: input.projectId },
			select: { id: true },
		});
		if (!story) {
			throw new ORPCError("NOT_FOUND", { message: "Story not found" });
		}

		return await listStoryPriorityHistory({
			storyId: input.storyId,
			projectId: input.projectId,
			cursor: input.cursor ?? null,
			limit: input.limit ?? DEFAULT_LIMIT,
		});
	});
