/**
 * Cancel Task Agent Procedure
 *
 * Sends a cancel signal to stop the TaskAgentWorkflow.
 * Supports graceful cancellation (signal) and force termination.
 */

import { ORPCError } from "@orpc/client";
import { db } from "@repo/database";
import { getTemporalClient } from "@repo/temporal";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../../orpc/procedures";

export const cancelTaskAgentProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.STORY_DELETE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/stories/{storyId}/tasks/{taskId}/agent/cancel",
		tags: ["Projects", "Stories", "Tasks", "Agents"],
		summary: "Cancel an agent workflow",
		description:
			"Sends a cancel signal to stop the agent working on a task. Use force=true to terminate immediately.",
	})
	.input(
		z.object({
			projectId: z.string(),
			storyId: z.string(),
			taskId: z.string(),
			force: z.boolean().optional().default(false),
		}),
	)
	.output(
		z.object({
			success: z.boolean(),
			message: z.string(),
		}),
	)
	.handler(async ({ input }) => {
		const { projectId, storyId, taskId, force } = input;

		// Get the task with agent info
		const task = await db.storyTask.findFirst({
			where: {
				id: taskId,
				storyId,
				story: { projectId },
			},
			select: {
				agentTaskId: true,
				agentStatus: true,
			},
		});

		if (!task) {
			throw new ORPCError("NOT_FOUND", {
				message: "Task not found",
			});
		}

		if (!task.agentTaskId) {
			throw new ORPCError("BAD_REQUEST", {
				message: "No agent is running on this task",
			});
		}

		// Check if agent is in a cancellable state
		if (
			task.agentStatus &&
			["completed", "failed", "cancelled"].includes(task.agentStatus)
		) {
			throw new ORPCError("BAD_REQUEST", {
				message: "Agent workflow has already ended",
			});
		}

		const workflowId = `task-agent-${task.agentTaskId}`;

		try {
			// Get Temporal client
			const temporal = await getTemporalClient();

			// Get the workflow handle
			const handle = temporal.workflow.getHandle(workflowId);

			if (force) {
				// Force terminate the workflow immediately
				// This will stop all running activities and end the workflow
				await handle.terminate("User requested force termination");

				// Update the task status in the database
				await db.storyTask.update({
					where: { id: taskId },
					data: {
						agentStatus: "cancelled",
						agentCompletedAt: new Date(),
						agentError: "Workflow terminated by user",
					},
				});

				return {
					success: true,
					message: "Agent workflow terminated",
				};
			}

			// Graceful cancellation - send the cancel signal
			// Note: This only works if the workflow is not waiting for an activity
			await handle.signal("cancelWorkflow");

			return {
				success: true,
				message: "Cancel signal sent to agent workflow",
			};
		} catch (error) {
			// If the workflow doesn't exist or already ended, just update the task
			if (error instanceof Error && error.message.includes("not found")) {
				await db.storyTask.update({
					where: { id: taskId },
					data: {
						agentStatus: "cancelled",
						agentCompletedAt: new Date(),
					},
				});
				return {
					success: true,
					message: "Workflow already ended, status updated",
				};
			}

			throw new ORPCError("INTERNAL_SERVER_ERROR", {
				message: `Failed to cancel agent: ${error instanceof Error ? error.message : "Unknown error"}`,
			});
		}
	});
