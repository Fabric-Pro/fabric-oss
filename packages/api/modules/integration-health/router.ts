/**
 * Integration health router.
 *
 * Read procedures are `protectedProcedure` — every authenticated user can
 * see provider health, the active-incident banner, and historical timelines.
 * The data is non-tenant-scoped (a provider outage affects everyone).
 *
 * Mutations (acknowledge/resolve/addComment) are `adminProcedure` because
 * they touch the GLOBAL `IntegrationIncident` table.
 *
 * Mounted at `router.integrationHealth.*` in `packages/api/orpc/router.ts`.
 */
import { acknowledgeIntegrationIncidentProcedure } from "./procedures/acknowledge-integration-incident";
import { addIntegrationCommentProcedure } from "./procedures/add-comment";
import { getProviderHealthProcedure } from "./procedures/get-provider-health";
import { getProviderIncidentsProcedure } from "./procedures/get-provider-incidents";
import { listActiveIncidentsProcedure } from "./procedures/list-active-incidents";
import { listIntegrationEventsProcedure } from "./procedures/list-events";
import { listProviderHealthProcedure } from "./procedures/list-provider-health";
import { resolveIntegrationIncidentProcedure } from "./procedures/resolve-integration-incident";

export const integrationHealthRouter = {
	// Read procedures (authenticated users)
	listProviderHealth: listProviderHealthProcedure,
	getProviderHealth: getProviderHealthProcedure,
	getProviderIncidents: getProviderIncidentsProcedure,
	listActiveIncidents: listActiveIncidentsProcedure,
	// Admin-only reads (event timeline reveals actor identity)
	listEvents: listIntegrationEventsProcedure,
	// Mutations (admin only)
	acknowledgeIntegrationIncident: acknowledgeIntegrationIncidentProcedure,
	resolveIntegrationIncident: resolveIntegrationIncidentProcedure,
	addComment: addIntegrationCommentProcedure,
};
