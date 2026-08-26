/**
 * Incidents router (admin-only).
 *
 * All procedures use `adminProcedure` because the underlying tables
 * (`ErrorRateIncident`, `IncidentEvent`) are GLOBAL — admins (Fabric
 * staff) own thresholds.
 *
 * Mounted at `router.incidents.errorRate.*` in `packages/api/orpc/router.ts`.
 * Adding the parent `errorRate` namespace leaves room for a future
 * `incidents.integration.*` namespace if we move the integration-incident
 * admin mutations from the `integration-health` router into this one.
 */
import { acknowledgeErrorRateIncidentProcedure } from "./procedures/acknowledge-error-rate-incident";
import { addCommentProcedure } from "./procedures/add-comment";
import { getErrorRateIncidentProcedure } from "./procedures/get-error-rate-incident";
import { listComponentEventsProcedure } from "./procedures/list-component-events";
import { listErrorRateIncidentsProcedure } from "./procedures/list-error-rate-incidents";
import { listEventsProcedure } from "./procedures/list-events";
import { listIncidentHistoryProcedure } from "./procedures/list-incident-history";
import { resolveErrorRateIncidentProcedure } from "./procedures/resolve-error-rate-incident";

export const incidentsRouter = {
	errorRate: {
		list: listErrorRateIncidentsProcedure,
		get: getErrorRateIncidentProcedure,
		acknowledge: acknowledgeErrorRateIncidentProcedure,
		resolve: resolveErrorRateIncidentProcedure,
		addComment: addCommentProcedure,
		listEvents: listEventsProcedure,
	},
	// v3 admin-incidents pass: Fabric subsystem outage event drill-down for
	// the monitoring timeline. Parallel to `errorRate.listEvents`.
	component: {
		listEvents: listComponentEventsProcedure,
	},
	// Full incident history across all three streams (error-rate +
	// integration + component), all statuses + all severities, windowed.
	// Drives the admin monitoring "Incident history" timeline.
	listHistory: listIncidentHistoryProcedure,
};
