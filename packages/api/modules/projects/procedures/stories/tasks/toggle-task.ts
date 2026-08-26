import { ORPCError } from "@orpc/client";
import { toggleTaskComplete } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../../orpc/procedures";
import { dispatchLifecycleEvent } from "../../../../agent-deployments/lib/lifecycle-dispatcher";

export const toggleTaskProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.STORY_UPDATE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/stories/{storyId}/tasks/{taskId}/toggle",
		tags: ["Projects", "Stories", "Tasks"],
		summary: "Toggle task completion",
		description: "Toggle a task's completion status",
	})
	.input(
		z.object({
			projectId: z.string(),
			storyId: z.string(),
			taskId: z.string(),
			organizationId: z.string().nullable().optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		try {
			const task = await toggleTaskComplete(input.taskId);
			if (task.isCompleted) {
				const organizationId = resolveOrganizationId(
					input.organizationId,
					context.session,
				);
				dispatchLifecycleEvent({
					resource: "task",
					event: "completed",
					projectId: input.projectId,
					entityId: task.id,
					userId: context.user.id,
					organizationId,
					data: {
						storyId: input.storyId,
						taskId: task.id,
						title: task.title,
					},
				}).catch((error) => {
					console.warn(
						"[LifecycleDispatcher] Task completed dispatch failed:",
						error,
					);
				});
			}
			return { task };
		} catch {
			throw new ORPCError("NOT_FOUND", {
				message: "Task not found",
			});
		}
	});
