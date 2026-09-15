import { ORPCError } from "@orpc/client";
import { db } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import {
	loadMetricOrThrow,
	loadProjectTenant,
	METRIC_SELECT,
	metricScope,
	toMetricDto,
} from "./shared";

/**
 * Shifts `lastValue` into `previousValue` and stores the new observation.
 * Pure so the webhook ingress and the manual procedure apply the same rule.
 */
function applyMetricObservation(
	current: { lastValue: number | null },
	value: number,
	observedAt: Date,
): { lastValue: number; previousValue: number | null; lastObservedAt: Date } {
	return {
		previousValue: current.lastValue,
		lastValue: value,
		lastObservedAt: observedAt,
	};
}

/**
 * AUTHORIZATION: `requireProjectPermission(PROJECT_UPDATE)` — editors and up.
 * Manual observation for MANUAL metrics (and a fallback for WEBHOOK ones).
 */
export const recordMetricObservationProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_UPDATE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/metrics/{metricId}/observations",
		tags: ["Projects", "Metrics"],
		summary: "Record metric observation",
		description:
			"Record a new value for a success metric. The previous value is kept for drift detection.",
	})
	.input(
		z.object({
			projectId: z.string(),
			metricId: z.string(),
			organizationId: z.string().nullable().optional(),
			value: z.number().finite(),
			observedAt: z.coerce.date().optional(),
		}),
	)
	.handler(async ({ input }) => {
		const project = await loadProjectTenant(input.projectId);
		const existing = await loadMetricOrThrow(input.metricId, project);
		const observedAt = input.observedAt ?? new Date();
		if (observedAt.getTime() > Date.now() + 5 * 60_000) {
			throw new ORPCError("BAD_REQUEST", {
				message: "observedAt cannot be in the future",
			});
		}

		await db.projectSuccessMetric.updateMany({
			where: { id: existing.id, ...metricScope(project) },
			data: applyMetricObservation(existing, input.value, observedAt),
		});
		const row = await db.projectSuccessMetric.findFirst({
			where: { id: existing.id, ...metricScope(project) },
			select: METRIC_SELECT,
		});
		return { metric: toMetricDto(row ?? existing) };
	});
