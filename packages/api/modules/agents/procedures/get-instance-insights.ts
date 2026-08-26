/**
 * Get Instance Insights Procedure
 *
 * Returns aggregated execution metrics for an agent template instance.
 * Covers the last 30 days of execution data.
 *
 * AUTHORIZATION: Tenant-isolated — user must own the instance (XOR pattern)
 */

import { ORPCError } from "@orpc/server";
import { db } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireInputOrgPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";

const RecentRunSchema = z.object({
	id: z.string(),
	status: z.string(),
	duration: z.number().nullable(),
	startedAt: z.date().nullable(),
	triggerType: z.string().nullable(),
});

const DayBucketSchema = z.object({
	date: z.string(),
	count: z.number(),
});

const InsightsSchema = z.object({
	totalRuns: z.number(),
	successRate: z.number(),
	avgDurationMs: z.number(),
	recentRuns: z.array(RecentRunSchema),
	runsByDay: z.array(DayBucketSchema),
});

/**
 * AUTHORIZATION: Uses XOR tenant pattern — verifies userId + organizationId ownership
 */
export const getInstanceInsights = tenantProtectedProcedure
	.use(requireInputOrgPermission(Permissions.AGENT_READ))
	.route({
		method: "GET",
		path: "/agents/instances/insights",
		tags: ["Agent Instances"],
		summary: "Get instance execution insights",
		description:
			"Returns aggregated execution metrics for an agent instance over the last 30 days, including success rate, average duration, and run-by-day breakdown.",
	})
	.input(
		z.object({
			instanceId: z.string(),
			organizationId: z.string().nullable().optional(),
		}),
	)
	.output(InsightsSchema)
	.handler(async ({ input, context }) => {
		const { user, session } = context;
		const organizationId = resolveOrganizationId(
			input.organizationId,
			session,
		);

		// XOR PATTERN: Strict tenant isolation
		const tenantFilter = organizationId
			? { organizationId }
			: { userId: user.id, organizationId: null };

		// Verify the user has access to this instance
		const instance = await db.agentTemplateInstance.findFirst({
			where: {
				id: input.instanceId,
				...tenantFilter,
			},
			select: { id: true, sId: true },
		});

		if (!instance) {
			throw new ORPCError("NOT_FOUND", {
				message: "Instance not found or access denied",
			});
		}

		// Compute date window: last 30 days
		const thirtyDaysAgo = new Date();
		thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

		// Fetch all executions for any version of this instance (same sId) in last 30 days
		// We join through the instanceId which belongs to a specific version;
		// to aggregate across all versions of the same agent we query by sId.
		const allVersionIds = await db.agentTemplateInstance.findMany({
			where: { sId: instance.sId, ...tenantFilter },
			select: { id: true },
		});
		const instanceIds = allVersionIds.map((v) => v.id);

		const executions = await db.agentTemplateExecution.findMany({
			where: {
				instanceId: { in: instanceIds },
				createdAt: { gte: thirtyDaysAgo },
			},
			select: {
				id: true,
				status: true,
				duration: true,
				startedAt: true,
				triggerType: true,
				createdAt: true,
			},
			orderBy: { createdAt: "desc" },
		});

		// Aggregate metrics
		const totalRuns = executions.length;

		const completedRuns = executions.filter(
			(e) => e.status === "COMPLETED",
		);
		const successRate =
			totalRuns > 0
				? Math.round((completedRuns.length / totalRuns) * 100)
				: 0;

		const runsWithDuration = executions.filter(
			(e) => e.duration !== null && e.duration !== undefined,
		);
		const avgDurationMs =
			runsWithDuration.length > 0
				? Math.round(
						runsWithDuration.reduce(
							(sum, e) => sum + (e.duration ?? 0),
							0,
						) / runsWithDuration.length,
					)
				: 0;

		// Recent runs — last 10
		const recentRuns = executions.slice(0, 10).map((e) => ({
			id: e.id,
			status: e.status,
			duration: e.duration,
			startedAt: e.startedAt,
			triggerType: e.triggerType,
		}));

		// Runs by day — last 14 days
		const runsByDay: Array<{ date: string; count: number }> = [];
		for (let i = 13; i >= 0; i--) {
			const day = new Date();
			day.setDate(day.getDate() - i);
			const dateStr = day.toISOString().slice(0, 10); // "YYYY-MM-DD"
			const count = executions.filter((e) => {
				const execDate = e.createdAt.toISOString().slice(0, 10);
				return execDate === dateStr;
			}).length;
			runsByDay.push({ date: dateStr, count });
		}

		return {
			totalRuns,
			successRate,
			avgDurationMs,
			recentRuns,
			runsByDay,
		};
	});
