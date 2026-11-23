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
		// Resolved at handler entry, BEFORE anything is written: it can still
		// refuse (a project with no organization), and refusing after the
		// write would leave it committed behind a failed response.
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);
		// Scoped to the story and project the gate authorized: a task id from
		// anywhere else is not found, and nothing is written.
		const task = await toggleTaskComplete({
			taskId: input.taskId,
			storyId: input.storyId,
			projectId: input.projectId,
		}).catch(() => null);
		if (!task) {
			throw new ORPCError("NOT_FOUND", {
				message: "Task not found",
			});
		}
		if (task.isCompleted) {
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
	});
