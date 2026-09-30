import { db } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { PARLUME_FEATURE_KEY } from "../../lib/parlume-usage";
import { requireParlumeProject } from "./sessions";

export const getParlumeUsageProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_READ))
	.route({
		method: "GET",
		path: "/projects/{projectId}/parlume/usage",
		tags: ["Projects", "Parlume"],
		summary: "Parlume AI and meeting-provider spend for this project",
	})
	.input(z.object({ projectId: z.string() }))
	.handler(async ({ input }) => {
		const project = await requireParlumeProject(input.projectId);
		// Every Parlume usage row stores its session id in `conversationId`, so
		// one grouped query yields both the project total and the per-meeting
		// split the Parlume page shows next to each session.
		const rows = await db.aiUsageLog.groupBy({
			by: ["conversationId"],
			where: {
				projectId: project.id,
				organizationId: project.organizationId,
				featureKey: PARLUME_FEATURE_KEY,
			},
			_sum: { costMicroUsd: true },
			_count: { _all: true },
		});
		const sessions = rows.flatMap((row) =>
			row.conversationId
				? [
						{
							sessionId: row.conversationId,
							costMicroUsd: row._sum.costMicroUsd ?? 0,
							calls: row._count._all,
						},
					]
				: [],
		);
		return {
			totalCostMicroUsd: rows.reduce(
				(total, row) => total + (row._sum.costMicroUsd ?? 0),
				0,
			),
			calls: rows.reduce((total, row) => total + row._count._all, 0),
			sessions,
		};
	});
