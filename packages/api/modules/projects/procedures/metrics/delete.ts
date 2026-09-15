import { db } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { loadMetricOrThrow, loadProjectTenant, metricScope } from "./shared";

/** AUTHORIZATION: `requireProjectPermission(PROJECT_UPDATE)` — editors and up. */
export const deleteMetricProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_UPDATE))
	.route({
		method: "DELETE",
		path: "/projects/{projectId}/metrics/{metricId}",
		tags: ["Projects", "Metrics"],
		summary: "Delete success metric",
		description: "Delete a customer success metric and its observations",
	})
	.input(
		z.object({
			projectId: z.string(),
			metricId: z.string(),
			organizationId: z.string().nullable().optional(),
		}),
	)
	.handler(async ({ input }) => {
		const project = await loadProjectTenant(input.projectId);
		const existing = await loadMetricOrThrow(input.metricId, project);
		await db.projectSuccessMetric.deleteMany({
			where: { id: existing.id, ...metricScope(project) },
		});
		return { success: true as const, metricId: existing.id };
	});
