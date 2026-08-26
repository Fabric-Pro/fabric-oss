/**
 * Jobs Router — the Job Hub's read side.
 *
 * Background job rows are written by Temporal activities (via
 * `@repo/database`), never through this router: there is no way to create,
 * mutate or cancel a job from the API. Cancellation is explicitly out of scope
 * for this iteration, so the surface is deliberately read-only.
 */

import { activeJobCountProcedure } from "./procedures/active-count";
import { listJobsProcedure } from "./procedures/list";

export const jobsRouter = {
	list: listJobsProcedure,
	activeCount: activeJobCountProcedure,
};
