/**
 * List frames attached to a story (plan Slice 3: spike demos).
 *
 * AUTHORIZATION: project-level STORY_READ via requireProjectPermission.
 * Project frames are readable by project members, not only their creator.
 */

import { listFramesForStory } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";

const inputSchema = z.object({
	projectId: z.string(),
	storyId: z.string(),
	organizationId: z.string().nullable().optional(),
	limit: z.number().int().positive().max(100).optional(),
});

export const listFramesForStoryProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.STORY_READ))
	.route({
		method: "GET",
		path: "/frames/for-story",
		tags: ["Frames"],
		summary: "List frames for a story",
		description:
			"List project-scoped Fabric Frames attached to a story (spike demos)",
	})
	.input(inputSchema)
	.handler(async ({ input }) => {
		const frames = await listFramesForStory({
			projectId: input.projectId,
			storyId: input.storyId,
			limit: input.limit,
		});
		return frames.map((frame) => ({
			...frame,
			createdAt: frame.createdAt.toISOString(),
			updatedAt: frame.updatedAt.toISOString(),
		}));
	});
