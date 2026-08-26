/**
 * QA evidence retention sweep.
 *
 * Scheduled daily and registered unconditionally; the QA feature gate lives in
 * the activity so flipping the flag takes effect on the next tick rather than on
 * the next deploy. The body is deterministic — no `Date.now()`, no env, no IO —
 * so replay stays clean.
 *
 * `maximumAttempts: 1` keeps the activity's own `MAX_DELETIONS` the true
 * per-execution destructive bound. The daily schedule is the retry cadence: a
 * sweep that fails halfway has deleted only objects it confirmed, and tomorrow's
 * run picks up the rest.
 */

import { proxyActivities } from "@temporalio/workflow";
import type * as activities from "../activities/qa-evidence-retention";

const { purgeExpiredRunEvidenceActivity } = proxyActivities<typeof activities>({
	startToCloseTimeout: "1 hour",
	heartbeatTimeout: "2 minutes",
	retry: {
		maximumAttempts: 1,
	},
});

export async function qaEvidenceRetentionWorkflow(): Promise<
	Awaited<ReturnType<typeof purgeExpiredRunEvidenceActivity>>
> {
	return await purgeExpiredRunEvidenceActivity();
}
