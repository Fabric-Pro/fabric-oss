/**
 * PM Sync Log Retention Workflow
 *
 * Scheduled every 24h (see `packages/temporal/src/schedules.ts`). Purges
 * `pm_sync_log` rows older than `FABRIC_PM_SYNC_LOG_RETENTION_DAYS` by
 * delegating to `purgeExpiredPmSyncLogRowsActivity`. The workflow itself
 * contains zero side effects: no env reads, no `Date.now()`, no Prisma
 * calls — every state change happens inside the activity so replay stays
 * deterministic. Mirrors `audit-log-retention.ts` (workflow).
 *
 * Replay validation: per CLAUDE.md, any change under
 * `packages/temporal/src/workflows/**` triggers the CI replay validation
 * workflow (`.github/workflows/temporal-replay-validation.yml`) on PRs to
 * main. Local re-validation:
 *
 *   pnpm --filter @repo/temporal fetch:replay-histories
 *   pnpm --filter @repo/temporal test:replay
 *
 * Registration: the schedule `pm-sync-log-retention` is registered on
 * worker startup only when `FABRIC_PM_SYNC_LOG_RETENTION_ENABLED === "true"`.
 * The schedule id is stable across restarts so re-registration is
 * idempotent (handled by the `ScheduleAlreadyRunning` catch branch in
 * `schedules.ts`).
 */

import { proxyActivities } from "@temporalio/workflow";
import type * as activities from "../activities/pm-sync-log-retention";

const { purgeExpiredPmSyncLogRowsActivity } = proxyActivities<
	typeof activities
>({
	// Activity does batched deletes; 10 minutes is plenty for a single
	// run even at the 5M-row hard cap (the cap itself is the deliberate
	// stop, not the timeout).
	startToCloseTimeout: "10 minutes",
	retry: {
		// Idempotent in effect — a retry following partial progress just
		// deletes whatever still falls past the cutoff. Three attempts is
		// enough; Temporal logs the failure on the fourth and the next
		// scheduled run picks up where this one stopped.
		initialInterval: "30 seconds",
		maximumInterval: "5 minutes",
		backoffCoefficient: 2,
		maximumAttempts: 3,
	},
});

/**
 * PM Sync Log Retention workflow.
 *
 * Deterministic outer: a single activity call, no clock reads, no env
 * reads, no DB access. The activity handles the env read, batched delete
 * loop, safety cap, and self-event emission.
 */
export async function pmSyncLogRetentionWorkflow(): Promise<{
	deletedCount: number;
	cutoffAt: string;
	retentionDays: number;
	hitSafetyCap: boolean;
}> {
	return await purgeExpiredPmSyncLogRowsActivity();
}
