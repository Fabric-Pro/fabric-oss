/**
 * List the full incident history across all three streams (admin-only),
 * server-side filtered + paginated.
 *
 * Unlike `integrationHealth.listActiveIncidents` (active SEV-1/2 only, feeds
 * the app-shell banner), this returns EVERY status (incl. RESOLVED) and EVERY
 * severity (incl. SEV-3) by default, windowed over the last `sinceDays` days.
 * It drives the admin monitoring dashboard's "Incident history" timeline.
 *
 * Wire shape: the DB helper merges the error-rate, integration, and component
 * streams into a single newest-first array of normalized rows (each tagged
 * with `kind`) and returns one page plus the summed `total`. The procedure
 * echoes `page` + `pageSize` so the UI can render the pager without tracking
 * them separately.
 *
 * Filtering happens SERVER-SIDE: `status` (all/active/hidden) and `source`
 * (all/error-rate/statuspage/synthetic/breaker/alertmanager/component) are
 * pushed into the Prisma `where`, so the DB isn't over-fetched the way the
 * old "fetch 200 × 3 streams then filter in the browser" path was.
 *
 * Tenant scope: GLOBAL — all three incident tables are global; admins own
 * thresholds. Per-org rollups go through the Notification path, not here.
 *
 * Auth: `adminProcedure` — system-admin only, like the other monitoring
 * procedures. The rows reveal cross-tenant operational state.
 */
import { listIncidentHistory } from "@repo/database";
import { z } from "zod";
import { adminProcedure } from "../../../orpc/procedures";

const inputSchema = z.object({
	sinceDays: z.number().int().min(1).max(365).default(30),
	status: z.enum(["all", "active", "hidden"]).default("all"),
	source: z
		.enum([
			"all",
			"error-rate",
			"statuspage",
			"synthetic",
			"breaker",
			"alertmanager",
			"component",
		])
		.default("all"),
	page: z.number().int().min(1).default(1),
	// Restrict to the three selectable page sizes; reject anything else at the
	// boundary so the DB helper never sees an arbitrary value.
	pageSize: z
		.union([z.literal(25), z.literal(50), z.literal(100)])
		.default(25),
});

export const listIncidentHistoryProcedure = adminProcedure
	.route({
		method: "GET",
		path: "/incidents/history",
		tags: ["Incidents"],
		summary: "List paginated incident history across all streams",
		description:
			"All-status, all-severity incident history (error-rate + integration + component) over a sliding window, server-side filtered by status/source and paginated. Admin-only.",
	})
	.input(inputSchema)
	.handler(async ({ input }) => {
		const { items, total } = await listIncidentHistory({
			sinceDays: input.sinceDays,
			status: input.status,
			source: input.source,
			page: input.page,
			pageSize: input.pageSize,
		});
		return {
			items,
			total,
			page: input.page,
			pageSize: input.pageSize,
		};
	});
