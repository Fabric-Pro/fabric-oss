/**
 * List currently-active SEV-1 / SEV-2 incidents across all three streams:
 * errorRate, integration, and (v3 admin-incidents pass) component.
 *
 * Drives the app-shell incident chip + the admin monitoring dashboard's
 * "Open Incidents" card list. Filtered to FIRING / ACKNOWLEDGED status AND
 * SEV1 / SEV2 severity (lower severity incidents never appear in the chip
 * — they live only in the admin dashboard).
 *
 * Auth: `protectedProcedure` — every authenticated user can call this, but
 * the IncidentChip itself gates rendering to system admins only (see
 * `canViewIncidentChip` in `apps/web/modules/saas/shared/components/IncidentChip.tsx`).
 */
import { listActiveSevHighIncidents } from "@repo/database";
import { protectedProcedure } from "../../../orpc/procedures";

export const listActiveIncidentsProcedure = protectedProcedure
	.route({
		method: "GET",
		path: "/integration-health/active-incidents",
		tags: ["Integration Health"],
		summary:
			"List active SEV-1 / SEV-2 incidents across error-rate, integration, and component streams",
	})
	.handler(async () => {
		const { errorRate, integration, component } =
			await listActiveSevHighIncidents();
		return { errorRate, integration, component };
	});
