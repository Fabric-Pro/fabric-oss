import { deleteStoryStatus } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../../orpc/procedures";

export const deleteStoryStatusProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.STORY_DELETE))
	.route({
		method: "DELETE",
		path: "/projects/{projectId}/stories/statuses/{statusId}",
		tags: ["Projects", "Stories"],
		summary: "Delete story status",
		description:
			"Delete a story status (Kanban column). Stories in this column are moved to the default status.",
	})
	.input(
		z.object({
			projectId: z.string(),
			statusId: z.string(),
			organizationId: z.string().nullable().optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		await deleteStoryStatus(input.statusId, input.projectId, {
			lastEditedByName: context.user.name ?? null,
			lastEditedSource: "MANUAL",
		});

		return { success: true };
	});
