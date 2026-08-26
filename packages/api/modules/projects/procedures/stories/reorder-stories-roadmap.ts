import { reorderStoriesRoadmap } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";

export const reorderStoriesRoadmapProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.STORY_UPDATE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/stories/reorder-roadmap",
		tags: ["Projects", "Stories"],
		summary: "Reorder user stories in the Roadmap",
		description:
			"Reorder user stories within a Roadmap priority bucket. Updates roadmapOrder only — never touches the Kanban order field.",
	})
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
			storyOrders: z.array(
				z.object({
					id: z.string(),
					roadmapOrder: z.number(),
				}),
			),
		}),
	)
	.handler(async ({ input }) => {
		await reorderStoriesRoadmap(input.projectId, input.storyOrders);

		return { success: true };
	});
