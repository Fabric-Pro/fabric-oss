/**
 * Start Task Agent Procedure
 *
 * Triggers the TaskAgentWorkflow for a specific story task.
 * The agent will work on the task using MCP tools and request
 * approval at checkpoints before irreversible actions.
 */

import { ORPCError } from "@orpc/client";
import { createId } from "@paralleldrive/cuid2";
import { db } from "@repo/database";
import { getTemporalClient } from "@repo/temporal";
import { z } from "zod";
import { withCorrelationMemo } from "../../../../../lib/temporal-correlation";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../../orpc/procedures";

export const startTaskAgentProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.STORY_UPDATE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/stories/{storyId}/tasks/{taskId}/agent/start",
		tags: ["Projects", "Stories", "Tasks", "Agents"],
		summary: "Start an AI agent to work on a task",
		description:
			"Starts a Temporal workflow that runs an AI agent to complete the task using available MCP tools",
	})
	.input(
		z.object({
			projectId: z.string(),
			storyId: z.string(),
			taskId: z.string(),
		}),
	)
	.output(
		z.object({
			planId: z.string(),
			workflowId: z.string(),
			runId: z.string(),
			status: z.string(),
		}),
	)
	.handler(async ({ input, context }) => {
		const { user } = context;
		const { projectId, storyId, taskId } = input;

		// Fetch the task with story, project context, and repository info
		const task = await db.storyTask.findFirst({
			where: {
				id: taskId,
				storyId,
				story: { projectId },
			},
			include: {
				story: {
					select: {
						title: true,
						description: true,
						acceptanceCriteria: true,
						project: {
							select: {
								name: true,
								description: true,
								organizationId: true, // Required for tenant isolation
								// Project-level repository (fallback for tasks)
								repositoryUrl: true,
								repositoryOwner: true,
								repositoryName: true,
								defaultBranch: true,
							},
						},
					},
				},
			},
		});

		if (!task) {
			throw new ORPCError("NOT_FOUND", {
				message: "Task not found",
			});
		}

		// Check if agent is already running on this task
		if (
			task.agentStatus &&
			!["completed", "failed", "cancelled"].includes(task.agentStatus)
		) {
			// Double-check with Temporal if workflow is actually running
			// This handles cases where workflow crashed but DB wasn't updated
			if (task.agentTaskId) {
				try {
					const temporal = await getTemporalClient();
					const workflowId = `task-agent-${task.agentTaskId}`;
					const handle = temporal.workflow.getHandle(workflowId);
					const description = await handle.describe();

					// If workflow is actually running, block
					if (
						description.status.name === "RUNNING" ||
						description.status.name === "CONTINUED_AS_NEW"
					) {
						throw new ORPCError("CONFLICT", {
							message: "An agent is already working on this task",
						});
					}

					// Workflow is not running - update status and allow restart
					await db.storyTask.update({
						where: { id: taskId },
						data: {
							agentStatus:
								description.status.name === "COMPLETED"
									? "completed"
									: "failed",
						},
					});
				} catch (error) {
					// If we can't reach Temporal or workflow not found, allow restart
					if (
						error instanceof ORPCError &&
						error.code === "CONFLICT"
					) {
						throw error;
					}
					// Reset status for failed/not-found workflows
					await db.storyTask.update({
						where: { id: taskId },
						data: { agentStatus: "failed" },
					});
				}
			}
		}

		// Generate plan ID
		const planId = createId();

		try {
			// Get Temporal client
			const temporal = await getTemporalClient();

			// Start TaskAgentWorkflow
			const workflowId = `task-agent-${planId}`;
			const handle = await temporal.workflow.start(
				"taskAgentWorkflow",
				withCorrelationMemo({
					taskQueue: "agents",
					workflowId,
					args: [
						{
							planId,
							taskId,
							projectId,
							userId: user.id,
							// CRITICAL: Use PROJECT's organizationId for tenant isolation
							organizationId:
								task.story.project.organizationId || undefined,
							taskTitle: task.title,
							taskDescription: task.description || "",
							projectContext: {
								projectName: task.story.project.name,
								projectDescription:
									task.story.project.description ?? undefined,
							},
							storyContext: {
								storyTitle: task.story.title,
								storyDescription:
									task.story.description ?? undefined,
								acceptanceCriteria:
									task.story.acceptanceCriteria ?? undefined,
							},
							// Repository context for code tasks - task overrides project default
							repositoryContext: (() => {
								// Task-level repository takes precedence
								if (task.repositoryUrl) {
									return {
										repositoryUrl: task.repositoryUrl,
										repositoryOwner:
											task.repositoryOwner ?? undefined,
										repositoryName:
											task.repositoryName ?? undefined,
										targetBranch:
											task.targetBranch ?? "main",
									};
								}
								// Fall back to project-level repository
								const project = task.story.project;
								if (project.repositoryUrl) {
									return {
										repositoryUrl: project.repositoryUrl,
										repositoryOwner:
											project.repositoryOwner ??
											undefined,
										repositoryName:
											project.repositoryName ?? undefined,
										targetBranch:
											project.defaultBranch ?? "main",
									};
								}
								return undefined;
							})(),
						},
					],
				}),
			);

			return {
				planId,
				workflowId: handle.workflowId,
				runId: handle.firstExecutionRunId,
				status: "started",
			};
		} catch (error) {
			throw new ORPCError("INTERNAL_SERVER_ERROR", {
				message: `Failed to start agent: ${error instanceof Error ? error.message : "Unknown error"}`,
			});
		}
	});
