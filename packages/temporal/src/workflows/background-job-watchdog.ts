/**
 * Background Job Watchdog Workflow (Job Hub)
 *
 * Runs every few minutes (see `packages/temporal/src/schedules.ts`). Fails
 * `background_job` rows whose heartbeat has gone stale — a worker that died
 * mid-run never gets to write the closing status, so without this the row
 * stays "Running" forever and the navigation badge never clears.
 *
 * It also sweeps abandoned project scans (Fizzy #1930). Those rows had no
 * durable closer of any kind — their own model, no sweep, and no read-time
 * self-heal like the Atlas analysis has — so an interrupted scan sat as
 * Running indefinitely. They are measured from `startedAt` rather than a
 * heartbeat, which the scan model does not carry.
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

/**
 * The return type is derived from the activity rather than restated.
 *
 * It was restated, and the restatement went stale the moment the activity
 * learned to sweep a second table: the workflow would have kept type-checking
 * while silently narrowing the new counts away. Deriving it means whatever the
 * sweep grows next arrives here on its own.
 *
 * Additive only, so replay of an in-flight execution is unaffected: the
 * workflow still awaits exactly one activity, in the same order.
 */
export async function backgroundJobWatchdogWorkflow(): Promise<
	Awaited<ReturnType<typeof failStaleBackgroundJobsActivity>>
> {
	return await failStaleBackgroundJobsActivity();
}
