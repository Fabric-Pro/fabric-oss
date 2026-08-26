/**
 * Background job retention + watchdog activities (Job Hub).
 *
 * Both are side-effect holders for their otherwise-deterministic workflows:
 * env reads, clock reads, and Prisma calls live here so the workflows replay
 * cleanly. Mirrors `audit-log-retention.ts`.
 */

import {
	failStaleBackgroundJobs,
	purgeExpiredBackgroundJobs,
} from "@repo/database";
import { logger } from "@repo/logs";

/**
 * How long a finished job stays visible in the Job Hub.
 *
 * Must agree with the API-side reader in
 * `packages/api/modules/jobs/lib/retention.ts` — the panel filters on the same
 * window this purge enforces, so a mismatch would either show rows that are
 * about to vanish or delete rows the panel still lists.
 */
const DEFAULT_RETENTION_DAYS = 7;
const MIN_RETENTION_DAYS = 1;
const MAX_RETENTION_DAYS = 30;

/**
 * How long a job may go without reporting progress before it is presumed dead.
 *
 * Must exceed the worst-case SILENT stretch of any instrumented activity, which
 * is its `startToCloseTimeout` multiplied by its retry attempts — not one
 * attempt. The binding case is code indexing's embed batch: 15 minutes x 5
 * attempts. Activities in that class heartbeat at the top of every attempt, so
 * the real gap is one attempt; this default is the backstop if one is missed.
 * Too low and the watchdog fails jobs that are merely mid-step.
 */
const DEFAULT_STALE_MINUTES = 45;

function resolveRetentionDays(): number {
	const raw = process.env.FABRIC_JOB_RETENTION_DAYS;
	const parsed = raw ? Number.parseInt(raw.trim(), 10) : Number.NaN;
	if (!Number.isFinite(parsed)) {
		return DEFAULT_RETENTION_DAYS;
	}
	return Math.min(MAX_RETENTION_DAYS, Math.max(MIN_RETENTION_DAYS, parsed));
}

function resolveStaleMinutes(): number {
	const raw = process.env.FABRIC_JOB_STALE_MINUTES;
	const parsed = raw ? Number.parseInt(raw.trim(), 10) : Number.NaN;
	if (!Number.isFinite(parsed) || parsed < 1) {
		return DEFAULT_STALE_MINUTES;
	}
	return parsed;
}

export interface PurgeExpiredBackgroundJobsOutput {
	deletedCount: number;
	retentionDays: number;
	batches: number;
}

/**
 * Delete job rows past the retention window, in batches with a safety cap.
 *
 * Idempotent in effect: a retry after partial progress simply deletes whatever
 * still falls past the cutoff.
 */
export async function purgeExpiredBackgroundJobsActivity(): Promise<PurgeExpiredBackgroundJobsOutput> {
	const retentionDays = resolveRetentionDays();
	const { deleted, batches } = await purgeExpiredBackgroundJobs({
		retentionDays,
	});

	logger.info("[BackgroundJobRetention] Purge complete", {
		deletedCount: deleted,
		retentionDays,
		batches,
	});

	return { deletedCount: deleted, retentionDays, batches };
}

export interface FailStaleBackgroundJobsOutput {
	failedCount: number;
	staleMinutes: number;
}

/**
 * Fail jobs whose worker died mid-run.
 *
 * Nothing else will ever close those rows: the closing write lives in the
 * activity that never got to run. Without this they sit in the panel as
 * permanently "Running" and the navigation badge never returns to zero —
 * exactly the silent-stall confusion the Job Hub exists to end.
 */
export async function failStaleBackgroundJobsActivity(): Promise<FailStaleBackgroundJobsOutput> {
	const staleMinutes = resolveStaleMinutes();
	const failedCount = await failStaleBackgroundJobs({ staleMinutes });

	if (failedCount > 0) {
		logger.warn("[BackgroundJobWatchdog] Failed stale jobs", {
			failedCount,
			staleMinutes,
		});
	}

	return { failedCount, staleMinutes };
}
