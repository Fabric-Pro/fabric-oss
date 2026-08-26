/**
 * PM Sync Log Retention Activity
 *
 * Purges `pm_sync_log` rows older than `FABRIC_PM_SYNC_LOG_RETENTION_DAYS`
 * in batches of 5,000 ordered by `createdAt ASC`. Driven by the daily
 * `pmSyncLogRetentionWorkflow` (Temporal Schedule). Modeled exactly on
 * `audit-log-retention.ts` — same batched-delete shape, same retain-forever
 * short-circuit, same 1,000-batch safety cap.
 *
 * Behaviour:
 *  - Reads `FABRIC_PM_SYNC_LOG_RETENTION_DAYS` at activity start. `0` (or
 *    unset / non-finite / negative) is the retain-forever short-circuit:
 *    the activity returns `{ deletedCount: 0 }` and emits NO self-event.
 *  - Computes `cutoffAt = now - retentionDays * 24h` ONCE up front so a
 *    long-running purge doesn't keep moving the window.
 *  - Deletes in batches via raw SQL with a `LIMIT 5000` subquery so each
 *    batch only scans the index head. Loops until a batch returns 0 OR
 *    the 1,000-iteration safety cap fires (covers up to 5M rows / run
 *    which is far beyond expected load).
 *  - After deletes complete, emits ONE fire-and-forget self-event.
 *
 * Self-event deviation from `audit-log-retention.ts` (deliberate):
 *  - The audit-log retention activity emits its self-event via
 *    `recordAudit` because `audit_log` is its native channel and the
 *    `audit.retention.purged` action is a member of the closed
 *    `AUDIT_ACTIONS` taxonomy.
 *  - PM-sync-log retention emits ONLY a structured `logger.info`
 *    self-event because (a) `AUDIT_ACTIONS` is closed and adding a
 *    `pm_sync_log.retention.purged` action would require editing
 *    `@repo/database`'s `audit-log.ts` (outside this change's scope), and
 *    (b) writing a `PmSyncLog` row as the self-event would require
 *    fabricated `entityType`/`entityId`/`title` values that would surface
 *    as a confusing "system" entry in the Sync History tab.
 *  - Correlation is preserved: the structured log carries the Temporal
 *    workflow `runId` so Grafana / log aggregators can join the purge run
 *    against its Temporal trace exactly as with the audit-log activity.
 *    (Precedent: `audit-log-retention.ts` itself notes it is modeled on
 *    the authority-cleanup activity, which has NO DB self-event row.)
 *
 * Idempotency: the activity is idempotent in effect (re-running deletes
 * whatever is currently past the cutoff). Temporal retries are safe — a
 * retry following partial progress just deletes whatever remains.
 */

import { db } from "@repo/database";
import { logger } from "@repo/logs";
import { activityInfo } from "@temporalio/activity";

/**
 * Pull a Temporal-flavoured correlation ID from the activity context.
 * Temporal's workflow `runId` is a perfect correlation identity for
 * workflow-originated events: every retry / replay of the same activity
 * attempt carries the same `runId`, and Grafana / log aggregators can join
 * against it cleanly. Falls back to `null` when the activity is called from
 * outside Temporal (unit tests).
 */
function readActivityCorrelationId(): string | null {
	try {
		return activityInfo().workflowExecution.runId;
	} catch {
		return null;
	}
}

/** Batch size per DELETE statement. */
const BATCH_SIZE = 5_000;
/** Maximum batches per invocation. 1,000 × 5,000 = 5M rows hard cap. */
const MAX_BATCHES = 1_000;

export interface PurgeExpiredPmSyncLogRowsResult {
	deletedCount: number;
	cutoffAt: string;
	retentionDays: number;
	hitSafetyCap: boolean;
}

/**
 * Read `FABRIC_PM_SYNC_LOG_RETENTION_DAYS` and coerce. Returns 0 for any
 * unset / NaN / negative value (retain-forever short-circuit).
 *
 * Clamped to `MAX_RETENTION_DAYS` to avoid producing a `cutoffAt` that
 * overflows JavaScript's representable Date range (~8.64e15 ms from
 * epoch). Without this clamp an operator setting an absurd value like
 * `1e20` would crash the activity on the first `cutoffAt.toISOString()`
 * call with `RangeError: Invalid time value`.
 */
const MAX_RETENTION_DAYS = 36_500; // 100 years — far beyond any sane policy.

function readRetentionDays(): number {
	const raw = process.env.FABRIC_PM_SYNC_LOG_RETENTION_DAYS;
	if (raw === undefined || raw === "") {
		return 0;
	}
	const parsed = Number(raw);
	if (!Number.isFinite(parsed) || parsed <= 0) {
		return 0;
	}
	return Math.min(MAX_RETENTION_DAYS, Math.floor(parsed));
}

/**
 * Purge expired pm_sync_log rows in 5,000-row batches.
 *
 * Returns the total number of deleted rows, the cutoff timestamp (ISO
 * string for log readability), the retention window in days, and a
 * `hitSafetyCap` flag so the workflow can surface a warning when the
 * 1,000-batch ceiling fires.
 */
export async function purgeExpiredPmSyncLogRowsActivity(): Promise<PurgeExpiredPmSyncLogRowsResult> {
	const retentionDays = readRetentionDays();

	// Retain forever — short-circuit. No self-event so the logs don't
	// accumulate one no-op purge line per day when retention is off.
	if (retentionDays <= 0) {
		logger.info(
			{
				event: "pm_sync_log.retention.skipped",
				reason: "retention_days_zero",
			},
			"[PmSyncLogRetention] FABRIC_PM_SYNC_LOG_RETENTION_DAYS=0 — skipping purge",
		);
		return {
			deletedCount: 0,
			cutoffAt: new Date().toISOString(),
			retentionDays: 0,
			hitSafetyCap: false,
		};
	}

	const cutoffAt = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
	let totalDeleted = 0;
	let batches = 0;
	let hitSafetyCap = false;

	logger.info(
		{
			event: "pm_sync_log.retention.started",
			retentionDays,
			cutoffAt: cutoffAt.toISOString(),
		},
		"[PmSyncLogRetention] Starting purge run",
	);

	while (batches < MAX_BATCHES) {
		// $executeRaw returns the number of affected rows. The subquery
		// `LIMIT 5000` lets each batch scan only the index head — without
		// it Postgres would scan every expired row per loop. The ORDER BY
		// inside the subquery narrows the scan to the index head; the outer
		// DELETE only cares about the set of ids, not their order.
		const affected = await db.$executeRaw`
			DELETE FROM "pm_sync_log"
			WHERE "id" IN (
				SELECT "id" FROM "pm_sync_log"
				WHERE "createdAt" < ${cutoffAt}
				ORDER BY "createdAt" ASC
				LIMIT ${BATCH_SIZE}
			)
		`;
		if (affected === 0) {
			break;
		}
		totalDeleted += affected;
		batches += 1;
	}

	if (batches >= MAX_BATCHES) {
		hitSafetyCap = true;
		logger.warn(
			{
				event: "pm_sync_log.retention.safety_cap_hit",
				maxBatches: MAX_BATCHES,
				batchSize: BATCH_SIZE,
				deletedCount: totalDeleted,
				retentionDays,
				cutoffAt: cutoffAt.toISOString(),
			},
			`[PmSyncLogRetention] Safety cap hit after ${MAX_BATCHES} batches (${totalDeleted} rows). Remaining rows will be purged on the next run.`,
		);
	}

	// Fire-and-forget self-event. Structured `logger.info` (NOT a DB row)
	// — see the file header for why this deviates from the audit-log
	// activity's `recordAudit` self-event. The `correlationId` is the
	// Temporal workflow `runId` so the purge run is joinable from log
	// aggregators exactly as the audit-log meta-event is.
	logger.info(
		{
			event: "pm_sync_log.retention.purged",
			deletedCount: totalDeleted,
			cutoffAt: cutoffAt.toISOString(),
			retentionDays,
			batches,
			hitSafetyCap,
			correlationId: readActivityCorrelationId(),
		},
		`[PmSyncLogRetention] Purged ${totalDeleted} pm_sync_log rows older than ${cutoffAt.toISOString()}`,
	);

	return {
		deletedCount: totalDeleted,
		cutoffAt: cutoffAt.toISOString(),
		retentionDays,
		hitSafetyCap,
	};
}
