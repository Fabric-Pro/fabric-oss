/**
 * Audit-log router.
 *
 * Procedures:
 *  - `audit.list` — paginated, filtered read; emits `audit.viewed`.
 *  - `audit.export` — CSV / NDJSON export; emits `audit.exported`.
 *  - `audit.taxonomy` — static event-key dictionary for filter chips.
 *  - `audit.stats` — aggregate counters for the viewer's stats strip.
 *  - `audit.searchMembers` — typeahead for the "Actor" filter combobox.
 *  - `audit.searchProjects` — typeahead for the "Project" filter combobox.
 *  - `audit.apiKeys.list` — list audit-scoped API keys for the tenant.
 *  - `audit.apiKeys.create` — mint a new audit-scoped key; returns raw value once.
 *  - `audit.apiKeys.rotate` — swap hash/prefix on an existing key; returns raw value once.
 *  - `audit.apiKeys.revoke` — flip `isActive=false` immediately.
 *
 * All are wired into the main router as `audit: auditRouter`.
 *
 * Spec: docs/audit-log/README.md §6.4
 * plus the public-REST audit-log API change.
 */

import {
	createAuditApiKeyProcedure,
	listAuditApiKeysProcedure,
	revokeAuditApiKeyProcedure,
	rotateAuditApiKeyProcedure,
} from "./procedures/api-keys";
import { exportAuditLogProcedure } from "./procedures/export";
import { listAuditLogProcedure } from "./procedures/list";
import { searchAuditActorMembersProcedure } from "./procedures/search-members";
import { searchAuditProjectsProcedure } from "./procedures/search-projects";
import { getAuditStatsProcedure } from "./procedures/stats";
import { getAuditTaxonomyProcedure } from "./procedures/taxonomy";
import { getAuditTracedRequestProcedure } from "./procedures/traced-request";

export const auditRouter = {
	list: listAuditLogProcedure,
	export: exportAuditLogProcedure,
	taxonomy: getAuditTaxonomyProcedure,
	stats: getAuditStatsProcedure,
	tracedRequest: getAuditTracedRequestProcedure,
	searchMembers: searchAuditActorMembersProcedure,
	searchProjects: searchAuditProjectsProcedure,
	apiKeys: {
		list: listAuditApiKeysProcedure,
		create: createAuditApiKeyProcedure,
		rotate: rotateAuditApiKeyProcedure,
		revoke: revokeAuditApiKeyProcedure,
	},
};
