/**
 * Background Job Retention Workflow (Job Hub)
 *
 * Scheduled daily (see `packages/temporal/src/schedules.ts`). Deletes
 * `background_job` rows past `FABRIC_JOB_RETENTION_DAYS` by delegating to
 * `purgeExpiredBackgroundJobsActivity`. The workflow itself has zero side
 * effects — no env reads, no `Date.now()`, no Prisma — so replay stays
 * deterministic. Same shape as `audit-log-retention.ts`.
 *
 * Unlike the audit-log purge (opt-in, because it destroys compliance history),
 * this one is registered unconditionally: job rows are ephemeral progress
 * telemetry, and the Job Hub's list query already treats anything past the
 * window as gone.
 */

import { proxyActivities } from "@temporalio/workflow";
import type * as activities from "../activities/background-job-retention";

const { purgeExpiredBackgroundJobsActivity } = proxyActivities<
	typeof activities
>({
	startToCloseTimeout: "10 minutes",
	retry: {
		// Idempotent in effect — a retry after partial progress deletes
		// whatever still falls past the cutoff.
		initialInterval: "30 seconds",
		maximumInterval: "5 minutes",
		backoffCoefficient: 2,
		maximumAttempts: 3,
	},
});

export async function backgroundJobRetentionWorkflow(): Promise<{
	deletedCount: number;
	retentionDays: number;
	batches: number;
}> {
	return await purgeExpiredBackgroundJobsActivity();
}
