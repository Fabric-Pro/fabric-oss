import { reorderStoryStatuses } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../../orpc/procedures";

export const reorderStoryStatusesProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.STORY_UPDATE))
	.route({
		method: "PATCH",
		path: "/projects/{projectId}/stories/statuses/reorder",
		tags: ["Projects", "Stories"],
		summary: "Reorder story statuses",
		description: "Reorder Kanban columns by updating their display order",
	})
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
			statusOrders: z.array(
				z.object({
					id: z.string(),
					order: z.number().int().min(0),
				}),
			),
		}),
	)
	.handler(async ({ input }) => {
		await reorderStoryStatuses(input.projectId, input.statusOrders);

		return { success: true };
	});
