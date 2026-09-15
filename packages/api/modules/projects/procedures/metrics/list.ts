import { db } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import {
	loadProjectTenant,
	METRIC_SELECT,
	metricScope,
	toMetricDto,
} from "./shared";

/**
 * AUTHORIZATION: `requireProjectPermission(PROJECT_READ)`. Every project
 * member sees the project's success metrics; the secret hash is stripped.
 */
export const listMetricsProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_READ))
	.route({
		method: "GET",
		path: "/projects/{projectId}/metrics",
		tags: ["Projects", "Metrics"],
		summary: "List success metrics",
		description: "List the project's customer success metrics",
	})
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
		}),
	)
	.handler(async ({ input }) => {
		const project = await loadProjectTenant(input.projectId);
		const rows = await db.projectSuccessMetric.findMany({
			where: metricScope(project),
			orderBy: { createdAt: "asc" },
			select: METRIC_SELECT,
		});
		return { metrics: rows.map(toMetricDto) };
	});
