/**
 * System-health router.
 *
 * Customer reads (`getOverview`, `listHistory`) are open to any authenticated
 * user — that is the point of the surface. Authoring (`admin.*`) is
 * `adminProcedure`, because publishing text every customer reads is a
 * platform-staff action.
 *
 * Mounted at `router.systemHealth.*`.
 */
import { appendStatusRevisionProcedure } from "./procedures/admin/append-revision";
import { listStatusUpdatesAdminProcedure } from "./procedures/admin/list";
import { publishStatusUpdateProcedure } from "./procedures/admin/publish";
import { getSystemHealthOverviewProcedure } from "./procedures/get-overview";
import { listStatusHistoryProcedure } from "./procedures/list-history";

export const systemHealthRouter = {
	getOverview: getSystemHealthOverviewProcedure,
	listHistory: listStatusHistoryProcedure,
	admin: {
		listStatusUpdates: listStatusUpdatesAdminProcedure,
		publishStatusUpdate: publishStatusUpdateProcedure,
		appendStatusRevision: appendStatusRevisionProcedure,
	},
};
