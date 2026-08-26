/**
 * Daily Brief Router
 *
 * Project-scoped AI digest of cross-tool activity. Procedures authorize via
 * Project join (PROJECT_READ / PROJECT_UPDATE) and derive the XOR tenant
 * scope from the project itself, not from the caller-supplied organizationId.
 */
import { hideReleaseNoteProcedure } from "./procedures/exclusions-hide";
import { listReleaseNoteExclusionsProcedure } from "./procedures/exclusions-list";
import { unhideReleaseNoteProcedure } from "./procedures/exclusions-unhide";
import { getProcedure } from "./procedures/get";
import { listProcedure } from "./procedures/list";
import { markReadProcedure } from "./procedures/mark-read";
import { regenerateProcedure } from "./procedures/regenerate";

export const dailyBriefRouter = {
	get: getProcedure,
	list: listProcedure,
	regenerate: regenerateProcedure,
	markRead: markReadProcedure,
	exclusions: {
		hide: hideReleaseNoteProcedure,
		unhide: unhideReleaseNoteProcedure,
		list: listReleaseNoteExclusionsProcedure,
	},
};
