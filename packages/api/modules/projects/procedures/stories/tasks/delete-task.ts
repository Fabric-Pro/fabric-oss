import { ORPCError } from "@orpc/client";
import { deleteTask } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../../orpc/procedures";

export const deleteTaskProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.STORY_DELETE))
	.route({
		method: "DELETE",
		path: "/projects/{projectId}/stories/{storyId}/tasks/{taskId}",
		tags: ["Projects", "Stories", "Tasks"],
		summary: "Delete task",
		description: "Delete a task from a user story",
	})
	.input(
		z.object({
			projectId: z.string(),
			storyId: z.string(),
			taskId: z.string(),
			organizationId: z.string().nullable().optional(),
		}),
	)
	.handler(async ({ input }) => {
		// Scoped to the story and project the gate authorized: a task id from
		// anywhere else is not found, and nothing is deleted.
		const deleted = await deleteTask({
			taskId: input.taskId,
			storyId: input.storyId,
			projectId: input.projectId,
		}).catch(() => false);
		if (!deleted) {
			throw new ORPCError("NOT_FOUND", {
				message: "Task not found",
			});
		}
		return { success: true };
	});
