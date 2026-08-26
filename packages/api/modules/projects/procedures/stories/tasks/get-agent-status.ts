/**
 * Get Task Agent Status Procedure
 *
 * Returns the current status of a task's agent workflow,
 * including steps, checkpoint data, and artifacts.
 */

import { ORPCError } from "@orpc/client";
import { db, hasProjectAccess } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../../orpc/procedures";

const AgentStepSchema = z.object({
	id: z.string(),
	name: z.string(),
	type: z.enum(["agent", "tool", "approval"]),
	status: z.enum([
		"pending",
		"running",
		"completed",
		"failed",
		"awaiting_approval",
	]),
	startedAt: z.string().optional(),
	completedAt: z.string().optional(),
	durationMs: z.number().optional(),
	result: z.unknown().optional(),
	error: z.string().optional(),
	thinking: z.string().optional(),
	toolName: z.string().optional(),
	toolArgs: z.record(z.string(), z.unknown()).optional(),
	approvalData: z.unknown().optional(),
});

const CheckpointDataSchema = z.object({
	stepId: z.string(),
	tool: z.string(),
	action: z.string(),
	data: z.record(z.string(), z.unknown()),
});

const WorkflowArtifactSchema = z.object({
	type: z.enum([
		"github_pr",
		"google_doc",
		"google_sheet",
		"gmail_message",
		"file",
		"other",
	]),
	url: z.string().optional(),
	title: z.string().optional(),
	description: z.string().optional(),
});

export const getAgentStatusProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.STORY_READ))
	.route({
		method: "GET",
		path: "/projects/{projectId}/stories/{storyId}/tasks/{taskId}/agent/status",
		tags: ["Projects", "Stories", "Tasks", "Agents"],
		summary: "Get agent workflow status",
		description: "Returns the current status of the task's agent workflow",
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
			hasAgent: z.boolean(),
			planId: z.string().nullable(),
			status: z.string().nullable(),
			isStuck: z.boolean(), // True if agent appears stuck (running too long without progress)
			stuckReason: z.string().nullable(), // Human-readable reason why agent is considered stuck
			error: z.string().nullable(),
			steps: z.array(AgentStepSchema),
			checkpoint: CheckpointDataSchema.nullable(),
			artifacts: z.array(WorkflowArtifactSchema),
			logs: z.array(
				z.object({
					id: z.string(),
					level: z.string(),
					message: z.string(),
					stepId: z.string().nullable(),
					timestamp: z.date(),
					metadata: z
						.object({
							type: z.string().optional(),
							tool: z.string().optional(),
							args: z.record(z.string(), z.unknown()).optional(),
							durationMs: z.number().optional(),
						})
						.nullable(),
				}),
			),
			startedAt: z.date().nullable(),
			completedAt: z.date().nullable(),
		}),
	)
	.handler(async ({ input, context }) => {
		const { user } = context;
		const { projectId, storyId, taskId } = input;

		// Check project access
		const hasAccess = await hasProjectAccess(projectId, user.id);
		if (!hasAccess) {
			throw new ORPCError("FORBIDDEN", {
				message: "You don't have permission to view this project",
			});
		}

		// Fetch the task with agent info
		const task = await db.storyTask.findFirst({
			where: {
				id: taskId,
				storyId,
				story: { projectId },
			},
			select: {
				agentTaskId: true,
				agentStatus: true,
				agentStartedAt: true,
				agentCompletedAt: true,
			},
		});

		if (!task) {
			throw new ORPCError("NOT_FOUND", {
				message: "Task not found",
			});
		}

		// If no agent has been run
		if (!task.agentTaskId) {
			return {
				hasAgent: false,
				planId: null,
				status: null,
				isStuck: false,
				stuckReason: null,
				error: null,
				steps: [],
				checkpoint: null,
				artifacts: [],
				logs: [],
				startedAt: null,
				completedAt: null,
			};
		}

		// Fetch the workflow plan
		const plan = await db.taskWorkflowPlan.findUnique({
			where: { id: task.agentTaskId },
		});

		if (!plan) {
			return {
				hasAgent: false,
				planId: task.agentTaskId,
				status: task.agentStatus,
				isStuck: false,
				stuckReason: null,
				error: null,
				steps: [],
				checkpoint: null,
				artifacts: [],
				logs: [],
				startedAt: task.agentStartedAt,
				completedAt: task.agentCompletedAt,
			};
		}

		// Fetch recent logs with metadata (Weft-style)
		const logsRaw = await db.taskWorkflowLog.findMany({
			where: { planId: plan.id },
			orderBy: { timestamp: "asc" }, // Chronological order like Weft
			take: 100, // More logs for better visibility
			select: {
				id: true,
				level: true,
				message: true,
				stepId: true,
				timestamp: true,
				metadata: true,
			},
		});

		// Parse metadata JSON and ensure proper typing
		const logs = logsRaw.map((log) => ({
			id: log.id,
			level: log.level,
			message: log.message,
			stepId: log.stepId,
			timestamp: log.timestamp,
			metadata: log.metadata as {
				type?: string;
				tool?: string;
				args?: Record<string, unknown>;
				durationMs?: number;
			} | null,
		}));

		// Parse steps and artifacts from plan
		const steps = (plan.steps as unknown[]) || [];
		const result = plan.result as {
			artifacts?: unknown[];
			error?: string;
		} | null;
		const artifacts = result?.artifacts || [];
		const checkpoint = plan.checkpointData as {
			stepId: string;
			tool: string;
			action: string;
			data: Record<string, unknown>;
		} | null;

		// Extract error from result or from logs
		let error: string | null = result?.error || null;
		if (!error && plan.status === "failed") {
			// Look for error in latest error log
			const errorLog = logs.find((log) => log.level === "error");
			if (errorLog) {
				error = errorLog.message;
			}
		}

		// Detect if agent is stuck
		let isStuck = false;
		let stuckReason: string | null = null;

		const isRunningStatus = ["running", "working", "executing"].includes(
			plan.status,
		);
		if (isRunningStatus && task.agentStartedAt) {
			const now = new Date();
			const startedAt = new Date(task.agentStartedAt);
			const runningMinutes =
				(now.getTime() - startedAt.getTime()) / (1000 * 60);

			// Check for stuck conditions
			const lastLog = logs.length > 0 ? logs[logs.length - 1] : null;
			const lastLogTime = lastLog ? new Date(lastLog.timestamp) : null;
			const minutesSinceLastLog = lastLogTime
				? (now.getTime() - lastLogTime.getTime()) / (1000 * 60)
				: runningMinutes;

			// Count recent errors in logs
			const recentLogs = logs.slice(-10);
			const errorCount = recentLogs.filter(
				(log) => log.level === "error",
			).length;
			const failedSteps = (steps as Array<{ status: string }>).filter(
				(s) => s.status === "failed",
			).length;

			// Stuck condition 1: Running for > 30 minutes with no activity in last 15 minutes
			if (runningMinutes > 30 && minutesSinceLastLog > 15) {
				isStuck = true;
				stuckReason = `No activity for ${Math.round(minutesSinceLastLog)} minutes`;
			}
			// Stuck condition 2: Running for > 60 minutes total
			else if (runningMinutes > 60) {
				isStuck = true;
				stuckReason = `Running for ${Math.round(runningMinutes)} minutes`;
			}
			// Stuck condition 3: Too many errors in recent logs (error loop)
			else if (errorCount >= 5) {
				isStuck = true;
				stuckReason = `${errorCount} errors in last ${recentLogs.length} operations`;
			}
			// Stuck condition 4: Too many failed steps
			else if (failedSteps >= 5) {
				isStuck = true;
				stuckReason = `${failedSteps} consecutive tool failures`;
			}
		}

		return {
			hasAgent: true,
			planId: plan.id,
			status: plan.status,
			isStuck,
			stuckReason,
			error,
			steps: steps as z.infer<typeof AgentStepSchema>[],
			checkpoint,
			artifacts: artifacts as z.infer<typeof WorkflowArtifactSchema>[],
			logs,
			startedAt: task.agentStartedAt,
			completedAt: task.agentCompletedAt,
		};
	});
