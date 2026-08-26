/**
 * Resolve Task Agent Checkpoint Procedure
 *
 * Sends a signal to the TaskAgentWorkflow to resolve a checkpoint.
 * Users can approve, request changes, or cancel the workflow.
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

export const resolveCheckpointProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.STORY_UPDATE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/stories/{storyId}/tasks/{taskId}/agent/checkpoint",
		tags: ["Projects", "Stories", "Tasks", "Agents"],
		summary: "Resolve an agent checkpoint",
		description:
			"Approve, request changes, or cancel the agent's pending action",
	})
	.input(
		z.object({
			projectId: z.string(),
			storyId: z.string(),
			taskId: z.string(),
			planId: z.string(),
			action: z.enum(["approve", "request_changes", "cancel"]),
			feedback: z.string().optional(),
			userData: z.record(z.string(), z.unknown()).optional(),
		}),
	)
	.output(
		z.object({
			success: z.boolean(),
			message: z.string(),
		}),
	)
	.handler(async ({ input }) => {
		const {
			projectId: _projectId,
			storyId: _storyId,
			taskId,
			planId,
			action,
			feedback,
			userData,
		} = input;

		// Verify the plan exists and belongs to the task
		const plan = await db.taskWorkflowPlan.findFirst({
			where: {
				id: planId,
				taskId,
			},
		});

		if (!plan) {
			throw new ORPCError("NOT_FOUND", {
				message: "Workflow plan not found",
			});
		}

		// Verify the workflow is at a checkpoint
		if (plan.status !== "checkpoint") {
			throw new ORPCError("BAD_REQUEST", {
				message: "Workflow is not waiting for approval",
			});
		}

		try {
			// Get Temporal client
			const temporal = await getTemporalClient();

			// Get the workflow handle
			const workflowId = `task-agent-${planId}`;
			const handle = temporal.workflow.getHandle(workflowId);

			// Send the checkpoint resolution signal
			await handle.signal("resolveCheckpoint", {
				action,
				feedback,
				userData,
			});

			const actionMessages: Record<string, string> = {
				approve: "Action approved, agent will continue",
				request_changes: "Changes requested, agent will revise",
				cancel: "Workflow cancelled",
			};

			return {
				success: true,
				message: actionMessages[action] || "Checkpoint resolved",
			};
		} catch (error) {
			throw new ORPCError("INTERNAL_SERVER_ERROR", {
				message: `Failed to resolve checkpoint: ${error instanceof Error ? error.message : "Unknown error"}`,
			});
		}
	});
