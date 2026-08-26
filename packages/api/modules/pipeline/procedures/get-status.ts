/**
 * Get Pipeline Status Procedure
 *
 * Returns detailed status of a pipeline execution including:
 * - Overall pipeline status
 * - Individual stage statuses with outputs
 * - Duration and progress information
 */

import { ORPCError } from "@orpc/client";
import { db } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";

const StageSchema = z.object({
	stage: z.string(),
	status: z.enum([
		"PENDING",
		"RUNNING",
		"COMPLETED",
		"FAILED",
		"CANCELLED",
		"SKIPPED",
	]),
	output: z.any().optional(),
	error: z.string().optional(),
	startedAt: z.string().optional(),
	completedAt: z.string().optional(),
	duration: z.number().optional(),
});

const PipelineStatusSchema = z.object({
	pipelineId: z.string(),
	status: z.enum([
		"PENDING",
		"RUNNING",
		"COMPLETED",
		"FAILED",
		"CANCELLED",
		"TIMED_OUT",
	]),
	currentStage: z.string().optional(),
	progress: z.number(), // 0-100
	stages: z.array(StageSchema),
	prd: z.string().optional(),
	stories: z.string().optional(),
	tasks: z.string().optional(),
	issuesCreated: z.number().optional(),
	startedAt: z.string().optional(),
	completedAt: z.string().optional(),
	totalDuration: z.number().optional(),
	error: z.string().optional(),
});

export const getPipelineStatusProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.WORKSPACE_READ))
	.route({
		method: "GET",
		path: "/pipeline/{pipelineId}/status",
		tags: ["Pipeline"],
		summary: "Get pipeline execution status",
		description:
			"Returns detailed status of a pipeline execution with stage outputs",
	})
	.input(
		z.object({
			pipelineId: z.string(),
		}),
	)
	.output(PipelineStatusSchema)
	.handler(async ({ input, context }) => {
		const user = context.user;

		// Get execution with logs
		const execution = await db.workflowExecution.findFirst({
			where: {
				id: input.pipelineId,
				userId: user.id,
			},
			include: {
				logs: {
					orderBy: { startedAt: "asc" },
				},
			},
		});

		if (!execution) {
			throw new ORPCError("NOT_FOUND", {
				message: "Pipeline not found",
			});
		}

		// Map logs to stages with proper type casting
		type StageStatus =
			| "PENDING"
			| "RUNNING"
			| "COMPLETED"
			| "FAILED"
			| "CANCELLED"
			| "SKIPPED";
		const stages = execution.logs.map((log) => ({
			stage: log.nodeId,
			status: log.status as StageStatus,
			output: log.output,
			error: log.error ?? undefined,
			startedAt: log.startedAt?.toISOString(),
			completedAt: log.completedAt?.toISOString(),
			duration: log.duration ?? undefined,
		}));

		// Calculate progress (COMPLETED, FAILED, and SKIPPED all count toward completion)
		const completedStages = stages.filter(
			(s) =>
				s.status === "COMPLETED" ||
				s.status === "FAILED" ||
				s.status === "SKIPPED",
		).length;
		const totalStages = stages.length || 3;
		const progress = Math.round((completedStages / totalStages) * 100);

		// Determine current stage
		const runningStage = stages.find((s) => s.status === "RUNNING");
		const currentStage = runningStage?.stage;

		// Extract outputs from completed stages
		const prdStage = stages.find((s) => s.stage === "prd_generation");
		const storyStage = stages.find((s) => s.stage === "story_breakdown");
		const taskStage = stages.find((s) => s.stage === "task_planning");
		const issueStage = stages.find((s) => s.stage === "issue_creation");

		// Get content from output
		const getOutputContent = (output: unknown): string | undefined => {
			if (!output) {
				return undefined;
			}
			if (typeof output === "string") {
				return output;
			}
			if (typeof output === "object" && output !== null) {
				const obj = output as Record<string, unknown>;
				if (typeof obj.content === "string") {
					return obj.content;
				}
			}
			return undefined;
		};

		type ExecutionStatus =
			| "PENDING"
			| "RUNNING"
			| "COMPLETED"
			| "FAILED"
			| "CANCELLED"
			| "TIMED_OUT";

		return {
			pipelineId: execution.id,
			status: execution.status as ExecutionStatus,
			currentStage,
			progress,
			stages,
			prd: getOutputContent(prdStage?.output),
			stories: getOutputContent(storyStage?.output),
			tasks: getOutputContent(taskStage?.output),
			issuesCreated:
				issueStage?.output && typeof issueStage.output === "object"
					? (issueStage.output as any).cardsCreated
					: undefined,
			startedAt: execution.startedAt?.toISOString(),
			completedAt: execution.completedAt?.toISOString(),
			totalDuration: execution.duration ?? undefined,
			error: execution.error ?? undefined,
		};
	});
