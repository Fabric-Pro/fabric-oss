/**
 * `audit.stats` — aggregate counters for the viewer's stats strip.
 *
 * Four numbers in one round-trip: events today, failures today, unique
 * actors today, and the most-recent event timestamp. Same scope-resolved
 * tenant isolation the list/export procedures use, so RLS + XOR are
 * preserved.
 *
 * Authorization mirrors `audit.list` — the read permission gate also
 * applies here. The endpoint does NOT emit a meta `audit.viewed` event;
 * the stats strip refreshes alongside the table and the table's own
 * `audit.viewed` is sufficient (a duplicate write would distort the
 * count).
 *
 * Spec: docs/audit-log/README.md §8.2
 * (viewer enhancements — stats strip).
 */

import { aggregateAuditLogStats } from "@repo/database";
import { requireAuditLogReadOrDeploymentAdmin } from "../../../orpc/middleware/require-audit-log-read";
import { protectedProcedure } from "../../../orpc/procedures";
import { auditStatsInputSchema, auditStatsOutputSchema } from "../lib/schemas";
import { resolveAuditLogScope } from "../lib/scope";

export const getAuditStatsProcedure = protectedProcedure
	.input(auditStatsInputSchema)
	.use(requireAuditLogReadOrDeploymentAdmin())
	.route({
		method: "POST",
		path: "/audit/stats",
		tags: ["Audit"],
		summary: "Aggregate audit-log counters",
		description:
			"Aggregate counters (events today, failures today, unique actors today, last event timestamp) for the viewer's stats strip.",
	})
	.output(auditStatsOutputSchema)
	.handler(async ({ input, context }) => {
		const scope = resolveAuditLogScope(context, input.organizationId);
		const stats = await aggregateAuditLogStats({
			scope,
			latencyWindow: input.latencyWindow,
		});
		return {
			eventsToday: stats.eventsToday,
			failuresToday: stats.failuresToday,
			uniqueActorsToday: stats.uniqueActorsToday,
			lastEventAt: stats.lastEventAt,
			topAction: stats.topAction,
			hourlyVolume: stats.hourlyVolume,
			sessionsToday: stats.sessionsToday,
			averageLatencyMs: stats.averageLatencyMs,
			latencySparkline: stats.latencySparkline,
			latencyWindow: stats.latencyWindow,
		};
	});
