import {
	listProjectsDueForPipelineSync,
	reapStaleAgenticRuns,
} from "@repo/database";
import { isTestCasesEnabled } from "@repo/utils/feature-flag";

export interface ProjectDueForPipelineSync {
	projectId: string;
	organizationId: string | null;
	userId: string | null;
	autoCreateBugsFromFailures: boolean;
}

/**
 * Activity: who should the scheduled pipeline-result sweep visit this tick?
 *
 * A thin wrapper so the enumeration is IO in an activity rather than in the
 * workflow body, which has to stay replay-safe.
 *
 * The scoping and the cap live in the query, not here — see
 * `listProjectsDueForPipelineSync`. Worth knowing at this level: the list is
 * bounded and ordered oldest-updated-first, so a deployment with more projects
 * than one tick can cover rotates through them instead of starving the tail.
 *
 * The feature gate lives HERE rather than on the schedule, matching every other
 * sweep in this package: the schedule stays registered, so turning the flag on
 * takes effect on the next tick with no redeploy, and turning it off empties the
 * due-list rather than leaving a schedule to delete.
 *
 * Without this the sweep called a customer's CI every fifteen minutes and wrote
 * result rows in an environment where the whole QA surface was switched off and
 * nothing could display them. The requirement is explicit that a disabled flag
 * means no results are *fetched* or shown; only the showing half was gated.
 */
export async function listProjectsDueForPipelineSyncActivity(input?: {
	limit?: number;
}): Promise<ProjectDueForPipelineSync[]> {
	if (!isTestCasesEnabled()) {
		return [];
	}
	return listProjectsDueForPipelineSync({ limit: input?.limit });
}

export async function reapStaleAgenticRunsActivity(): Promise<{
	reaped: number;
}> {
	return reapStaleAgenticRuns();
}
