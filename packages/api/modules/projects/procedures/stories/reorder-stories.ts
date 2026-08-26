import { reorderStories } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";

export const reorderStoriesProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.STORY_UPDATE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/stories/reorder",
		tags: ["Projects", "Stories"],
		summary: "Reorder user stories",
		description:
			"Reorder user stories within a Kanban column (drag-drop reorder)",
	})
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
			storyOrders: z.array(
				z.object({
					id: z.string(),
					order: z.number(),
				}),
			),
		}),
	)
	.handler(async ({ input }) => {
		await reorderStories(input.projectId, input.storyOrders);

		return { success: true };
	});
