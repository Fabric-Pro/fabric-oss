import { ORPCError } from "@orpc/client";
import { updateTask } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../../orpc/procedures";

export const updateTaskProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.STORY_UPDATE))
	.route({
		method: "PATCH",
		path: "/projects/{projectId}/stories/{storyId}/tasks/{taskId}",
		tags: ["Projects", "Stories", "Tasks"],
		summary: "Update task",
		description: "Update a task's title, description, or estimated hours",
	})
	.input(
		z.object({
			projectId: z.string(),
			storyId: z.string(),
			taskId: z.string(),
			title: z.string().min(1).max(500).optional(),
			description: z.string().max(2000).optional().nullable(),
			estimatedHours: z.number().min(0).max(1000).optional().nullable(),
			organizationId: z.string().nullable().optional(),
			// Repository context for code tasks
			repositoryUrl: z.string().url().optional().nullable(),
			repositoryOwner: z.string().max(100).optional().nullable(),
			repositoryName: z.string().max(100).optional().nullable(),
			targetBranch: z.string().max(100).optional().nullable(),
		}),
	)
	.handler(async ({ input }) => {
		try {
			const task = await updateTask(input.taskId, {
				title: input.title,
				description: input.description,
				estimatedHours: input.estimatedHours,
				// Repository context
				repositoryUrl: input.repositoryUrl,
				repositoryOwner: input.repositoryOwner,
				repositoryName: input.repositoryName,
				targetBranch: input.targetBranch,
			});
			return { task };
		} catch {
			throw new ORPCError("NOT_FOUND", {
				message: "Task not found",
			});
		}
	});
