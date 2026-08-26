/**
 * Background Job Watchdog Workflow (Job Hub)
 *
 * Runs every few minutes (see `packages/temporal/src/schedules.ts`). Fails
 * `background_job` rows whose heartbeat has gone stale — a worker that died
 * mid-run never gets to write the closing status, so without this the row
 * stays "Running" forever and the navigation badge never clears.
 *
 * Deterministic outer: one activity call, no clock or env reads. Mirrors the
 * `backlog-apply-watchdog` shape.
 */

import { proxyActivities } from "@temporalio/workflow";
import type * as activities from "../activities/background-job-retention";

const { failStaleBackgroundJobsActivity } = proxyActivities<typeof activities>({
	startToCloseTimeout: "2 minutes",
	retry: {
		initialInterval: "10 seconds",
		maximumInterval: "1 minute",
		backoffCoefficient: 2,
		maximumAttempts: 3,
	},
});

export async function backgroundJobWatchdogWorkflow(): Promise<{
	failedCount: number;
	staleMinutes: number;
}> {
	return await failStaleBackgroundJobsActivity();
}
