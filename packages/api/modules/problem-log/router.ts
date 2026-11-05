/**
 * Problem Log Router (Fizzy #2277)
 *
 * Project-scoped reads, status changes and draft reviews on the
 * organization's Problem Log.
 * Every procedure authorizes the project role, then requires membership of
 * the organization that owns the project (`lib/access.ts`).
 */
import { getProcedure } from "./procedures/get";
import { listProcedure } from "./procedures/list";
import { reportProcedure } from "./procedures/report";
import { reviewProcedure } from "./procedures/review";
import { setStatusProcedure } from "./procedures/set-status";

export const problemLogRouter = {
	list: listProcedure,
	get: getProcedure,
	setStatus: setStatusProcedure,
	review: reviewProcedure,
	report: reportProcedure,
};
