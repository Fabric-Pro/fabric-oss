/**
 * List Pipelines Procedure
 *
 * Returns a list of pipeline executions for the current user.
 */

import { db } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";

const PipelineSummarySchema = z.object({
	id: z.string(),
	projectName: z.string(),
	status: z.enum([
		"PENDING",
		"RUNNING",
		"COMPLETED",
		"FAILED",
		"CANCELLED",
		"TIMED_OUT",
	]),
	progress: z.number(),
	startedAt: z.string(),
	completedAt: z.string().optional(),
	duration: z.number().optional(),
});

export const listPipelinesProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.WORKSPACE_READ))
	.route({
		method: "GET",
		path: "/pipeline/list",
		tags: ["Pipeline"],
		summary: "List pipeline executions",
		description:
			"Returns a list of pipeline executions for the current user",
	})
	.input(
		z.object({
			limit: z.number().min(1).max(100).default(20),
			offset: z.number().min(0).default(0),
			organizationId: z.string().nullable().optional(),
		}),
	)
	.output(
		z.object({
			pipelines: z.array(PipelineSummarySchema),
			total: z.number(),
		}),
	)
	.handler(async ({ input, context }) => {
		const user = context.user;
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		// Query for pipeline executions (pipelineId is not null)
		const where = {
			userId: user.id,
			pipelineId: { not: null },
			...(organizationId && {
				organizationId,
			}),
		};

		const [executions, total] = await Promise.all([
			db.workflowExecution.findMany({
				where,
				orderBy: { startedAt: "desc" },
				take: input.limit,
				skip: input.offset,
				include: {
					logs: {
						select: { status: true },
					},
				},
			}),
			db.workflowExecution.count({ where }),
		]);

		type ExecutionStatus =
			| "PENDING"
			| "RUNNING"
			| "COMPLETED"
			| "FAILED"
			| "CANCELLED"
			| "TIMED_OUT";

		const pipelines = executions.map((exec) => {
			// Extract project name from trigger input
			const triggerInput = exec.triggerInput as any;
			const projectName: string =
				triggerInput?.projectName || "Unnamed Pipeline";

			// Calculate progress from logs
			const completedStages = exec.logs.filter(
				(log) => log.status === "COMPLETED" || log.status === "FAILED",
			).length;
			const totalStages = exec.logs.length || 4;
			const progress = Math.round((completedStages / totalStages) * 100);

			return {
				id: exec.id,
				projectName,
				status: exec.status as ExecutionStatus,
				progress,
				startedAt: exec.startedAt.toISOString(),
				completedAt: exec.completedAt?.toISOString(),
				duration: exec.duration ?? undefined,
			};
		});

		return { pipelines, total };
	});
