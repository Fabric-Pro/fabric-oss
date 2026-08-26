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
		try {
			await deleteTask(input.taskId);
			return { success: true };
		} catch {
			throw new ORPCError("NOT_FOUND", {
				message: "Task not found",
			});
		}
	});
