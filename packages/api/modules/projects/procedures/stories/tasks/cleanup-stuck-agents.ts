/**
 * Cleanup Stuck Agents Procedure
 *
 * Finds and marks stuck agent tasks as failed.
 * A task is considered stuck if:
 * - agentStatus is "running"/"working"/"executing"
 * - Started more than 2 hours ago
 * - No recent activity
 */

import { db } from "@repo/database";
import { getTemporalClient } from "@repo/temporal";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../../orpc/procedures";

const TWO_HOURS_MS = 2 * 60 * 60 * 1000;

export const cleanupStuckAgentsProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.STORY_UPDATE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/cleanup-stuck-agents",
		tags: ["Projects", "Agents"],
		summary: "Cleanup stuck agent tasks",
		description:
			"Finds and marks stuck agent tasks as failed. Tasks running for more than 2 hours with no activity are considered stuck.",
	})
	.input(
		z.object({
			projectId: z.string(),
			dryRun: z.boolean().optional().default(false),
		}),
	)
	.output(
		z.object({
			success: z.boolean(),
			found: z.number(),
			fixed: z.number(),
			tasks: z.array(
				z.object({
					id: z.string(),
					title: z.string(),
					agentStatus: z.string().nullable(),
					agentStartedAt: z.date().nullable(),
					hoursRunning: z.number(),
					action: z.string(),
				}),
			),
		}),
	)
	.handler(async ({ input }) => {
		const { projectId, dryRun } = input;

		const now = new Date();
		const twoHoursAgo = new Date(now.getTime() - TWO_HOURS_MS);

		// Find all stuck tasks in this project
		const stuckTasks = await db.storyTask.findMany({
			where: {
				story: { projectId },
				agentStatus: { in: ["running", "working", "executing"] },
				OR: [
					// Started more than 2 hours ago
					{ agentStartedAt: { lt: twoHoursAgo } },
					// Or no start time recorded (legacy tasks)
					{ agentStartedAt: null, agentTaskId: { not: null } },
				],
			},
			select: {
				id: true,
				title: true,
				agentTaskId: true,
				agentStatus: true,
				agentStartedAt: true,
			},
		});

		const results: Array<{
			id: string;
			title: string;
			agentStatus: string | null;
			agentStartedAt: Date | null;
			hoursRunning: number;
			action: string;
		}> = [];

		let fixed = 0;

		for (const task of stuckTasks) {
			const hoursRunning = task.agentStartedAt
				? (now.getTime() - task.agentStartedAt.getTime()) /
					(1000 * 60 * 60)
				: -1; // Unknown for legacy tasks

			let action = "skipped";

			// Check if Temporal workflow is still running
			let workflowStatus = "unknown";
			if (task.agentTaskId) {
				try {
					const temporal = await getTemporalClient();
					const handle = temporal.workflow.getHandle(
						`task-agent-${task.agentTaskId}`,
					);
					const description = await handle.describe();
					workflowStatus = description.status.name;
				} catch {
					// Workflow not found or error - it's definitely not running
					workflowStatus = "not_found";
				}
			}

			// If workflow is not running (or not found), mark task as failed
			const isWorkflowEnded = [
				"COMPLETED",
				"FAILED",
				"CANCELLED",
				"TERMINATED",
				"TIMED_OUT",
				"not_found",
			].includes(workflowStatus);

			if (isWorkflowEnded || hoursRunning > 4) {
				action = dryRun ? "would_mark_failed" : "marked_failed";

				if (!dryRun) {
					await db.storyTask.update({
						where: { id: task.id },
						data: {
							agentStatus: "failed",
							agentCompletedAt: now,
							agentError: `Agent appears stuck (${hoursRunning > 0 ? `running for ${hoursRunning.toFixed(1)} hours` : "no start time recorded"}). Workflow status: ${workflowStatus}`,
						},
					});

					// Also update the workflow plan if it exists
					if (task.agentTaskId) {
						await db.taskWorkflowPlan.updateMany({
							where: { id: task.agentTaskId },
							data: {
								status: "failed",
								result: {
									success: false,
									error: "Agent stuck - marked as failed by cleanup",
								},
							},
						});
					}

					fixed++;
				}
			} else {
				action = `still_running (workflow: ${workflowStatus})`;
			}

			results.push({
				id: task.id,
				title: task.title,
				agentStatus: task.agentStatus,
				agentStartedAt: task.agentStartedAt,
				hoursRunning: Math.round(hoursRunning * 10) / 10,
				action,
			});
		}

		return {
			success: true,
			found: stuckTasks.length,
			fixed,
			tasks: results,
		};
	});
