/**
 * Audit Log Retention Activity
 *
 * Purges `audit_log` rows older than `FABRIC_AUDIT_LOG_RETENTION_DAYS` in
 * batches of 5,000 ordered by `createdAt ASC`. Driven by the daily
 * `auditLogRetentionWorkflow` (Temporal Schedule). Modeled on the
 * authority-cleanup activity but with batched deletes and a self-audit
 * event for forensic correlation.
 *
 * Behaviour:
 *  - Reads `FABRIC_AUDIT_LOG_RETENTION_DAYS` at activity start. `0` (or
 *    unset / non-finite / negative) is the retain-forever short-circuit:
 *    the activity returns `{ deletedCount: 0 }` and emits NO
 *    `audit.retention.purged` event.
 *  - Computes `cutoffAt = now - retentionDays * 24h` ONCE up front so a
 *    long-running purge doesn't keep moving the window.
 *  - Deletes in batches via raw SQL with a `LIMIT 5000` subquery so each
 *    batch only scans the index head. Loops until a batch returns 0 OR
 *    the 1,000-iteration safety cap fires (covers up to 5M rows / 24h
 *    which is far beyond expected load).
 *  - After deletes complete, emits ONE `audit.retention.purged` event via
 *    the fire-and-forget `recordAudit` helper. The helper handles its own
 *    DB write — calling it inside the activity (which is itself a
 *    side-effecting boundary) keeps the workflow body deterministic.
 *
 * Idempotency: the activity is idempotent in effect (re-running deletes
 * whatever is currently past the cutoff). Temporal retries are safe — a
 * retry following partial progress just deletes whatever remains.
 *
 * See: docs/audit-log/README.md §9
 */

import { db, getSealedThroughAt, recordAudit } from "@repo/database";
import { logger } from "@repo/logs";
import { activityInfo } from "@temporalio/activity";

/**
 * Pull a Temporal-flavoured correlation ID from the activity context.
 * Temporal's workflow `runId` is a perfect correlation identity for
 * workflow-originated audit events: every retry / replay of the same
 * activity attempt carries the same `runId`, and Grafana / log
 * aggregators can join against it cleanly. Falls back to `null` when the
 * activity is called from outside Temporal (unit tests).
 */
function readActivityCorrelationId(): string | null {
	try {
		return activityInfo().workflowExecution?.runId ?? null;
	} catch {
		return null;
	}
}

/** Batch size per DELETE statement. */
const BATCH_SIZE = 5_000;
/** Maximum batches per invocation. 1,000 × 5,000 = 5M rows hard cap. */
const MAX_BATCHES = 1_000;

export interface PurgeExpiredAuditRowsResult {
	deletedCount: number;
	cutoffAt: string;
	retentionDays: number;
	hitSafetyCap: boolean;
	/**
	 * Rows past the retention cutoff that were NOT purged because an audit seal
	 * covers them. Non-zero means retention is being held back by tamper evidence,
	 * which is deliberate — see the seal floor in the activity body.
	 */
	withheldBySeal: number;
}

/**
 * Read `FABRIC_AUDIT_LOG_RETENTION_DAYS` and coerce. Returns 0 for
 * any unset / NaN / negative value (retain-forever short-circuit).
 *
 * Clamped to `MAX_RETENTION_DAYS` to avoid producing a `cutoffAt` that
 * overflows JavaScript's representable Date range (~8.64e15 ms from
 * epoch). Without this clamp an operator setting an absurd value like
 * `1e20` would crash the activity on the first `cutoffAt.toISOString()`
 * call with `RangeError: Invalid time value`.
 */
const MAX_RETENTION_DAYS = 36_500; // 100 years — far beyond any sane policy.

function readRetentionDays(): number {
	const raw = process.env.FABRIC_AUDIT_LOG_RETENTION_DAYS;
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
 * Purge expired audit rows in 5,000-row batches.
 *
 * Returns the total number of deleted rows, the cutoff timestamp (ISO
 * string for log readability), the retention window in days, and a
 * `hitSafetyCap` flag so the workflow can surface a warning when the
 * 1,000-batch ceiling fires.
 */
export async function purgeExpiredAuditRowsActivity(): Promise<PurgeExpiredAuditRowsResult> {
	const retentionDays = readRetentionDays();

	// Retain forever — short-circuit. No self-audit event so the table
	// doesn't accumulate one no-op row per day when retention is off.
	if (retentionDays <= 0) {
		logger.info(
			{
				event: "audit.retention.skipped",
				reason: "retention_days_zero",
			},
			"[AuditRetention] FABRIC_AUDIT_LOG_RETENTION_DAYS=0 — skipping purge",
		);
		return {
			deletedCount: 0,
			cutoffAt: new Date().toISOString(),
			retentionDays: 0,
			hitSafetyCap: false,
			withheldBySeal: 0,
		};
	}

	const cutoffAt = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);

	// Tamper-evidence floor. A seal's contentHash is a fold over the rows in its
	// window, and verification reports a content mismatch for DELETED rows exactly
	// as it does for modified or inserted ones. So purging inside a sealed window
	// makes that seal fail verification and read as tampering — and, far worse,
	// makes genuine tampering indistinguishable from routine retention, which
	// destroys the property the seal chain exists to provide.
	//
	// Rows at or after this instant are not yet covered by any seal and are safe to
	// delete. Rows before it are sealed and are WITHHELD, not purged.
	//
	// Consequence worth being explicit about: while sealing keeps up (hourly), the
	// seal floor sits near "now" and the retention cutoff sits days or months back,
	// so the deletable set is empty and retention legitimately deletes nothing. That
	// is the correct outcome for today — it fails toward keeping the audit trail and
	// its tamper evidence intact, rather than silently trading the SOC 2 control for
	// disk space. Deleting sealed history needs a signed, monotonic retention
	// watermark that verification can treat as "purged by policy" rather than
	// "content missing"; that design does not exist yet, and inventing it implicitly
	// here by just deleting the rows would be the wrong call.
	const sealedThroughAt = await getSealedThroughAt();
	const deleteFloorAt = sealedThroughAt;

	let withheldBySeal = 0;
	if (sealedThroughAt && sealedThroughAt > cutoffAt) {
		withheldBySeal = await db.auditLog.count({
			where: { createdAt: { lt: cutoffAt } },
		});
		logger.warn(
			{
				event: "audit.retention.withheld_sealed_rows",
				retentionDays,
				cutoffAt: cutoffAt.toISOString(),
				sealedThroughAt: sealedThroughAt.toISOString(),
				withheldBySeal,
			},
			"[AuditRetention] Rows past the retention cutoff are covered by an audit seal and were NOT purged — deleting them would make the seal chain report tampering. Retention of sealed history requires a signed retention watermark.",
		);
	}

	let totalDeleted = 0;
	let batches = 0;
	let hitSafetyCap = false;

	logger.info(
		{
			event: "audit.retention.started",
			retentionDays,
			cutoffAt: cutoffAt.toISOString(),
		},
		"[AuditRetention] Starting purge run",
	);

	while (batches < MAX_BATCHES) {
		// audit_log is append-only (WORM trigger `audit_log_worm`, migration
		// 20260702130000_audit_log_worm_tamper_evidence). Retention is the
		// sanctioned, itself-auditable purge path, so each batch opts in by
		// setting the per-transaction bypass GUC `app.audit_allow_delete = 'on'`
		// in the SAME transaction as the DELETE (SET LOCAL is transaction-scoped
		// and resets at COMMIT). Without it the trigger rejects the DELETE and
		// the retention run fails.
		//
		// $executeRaw returns the number of affected rows. The subquery
		// `LIMIT 5000` lets each batch scan only the index head — without
		// it Postgres would scan every expired row per loop. Using the
		// `(createdAt, id)` composite ordering inside the subquery is
		// unnecessary because the outer DELETE only cares about the set
		// of ids, not their order; ORDER BY here narrows the scan.
		const [, affected] = await db.$transaction([
			db.$executeRawUnsafe("SET LOCAL app.audit_allow_delete = 'on'"),
			db.$executeRaw`
				DELETE FROM "audit_log"
				WHERE "id" IN (
					SELECT "id" FROM "audit_log"
					WHERE "createdAt" < ${cutoffAt}
					  AND ("createdAt" >= ${deleteFloorAt}::timestamp OR ${deleteFloorAt}::timestamp IS NULL)
					ORDER BY "createdAt" ASC
					LIMIT ${BATCH_SIZE}
				)
			`,
		]);
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
				event: "audit.retention.safety_cap_hit",
				maxBatches: MAX_BATCHES,
				batchSize: BATCH_SIZE,
				deletedCount: totalDeleted,
				retentionDays,
				cutoffAt: cutoffAt.toISOString(),
			},
			`[AuditRetention] Safety cap hit after ${MAX_BATCHES} batches (${totalDeleted} rows). Remaining rows will be purged on the next run.`,
		);
	}

	logger.info(
		{
			event: "audit.retention.completed",
			deletedCount: totalDeleted,
			retentionDays,
			cutoffAt: cutoffAt.toISOString(),
			batches,
			hitSafetyCap,
		},
		`[AuditRetention] Purged ${totalDeleted} audit_log rows older than ${cutoffAt.toISOString()}`,
	);

	// Self-audit event. Fire-and-forget — uses `recordAudit` (not the
	// transactional form) because we don't want a failure to record the
	// meta-event to roll back the actual deletes. Failures are logged via
	// the standard `onAuditWriteFailure` path in @repo/database.
	//
	// Defensive try/catch: in production `recordAudit` returns void and
	// never throws synchronously (errors route through
	// `onAuditWriteFailure`), but a defective mock or future regression
	// must NOT crash the activity AFTER the deletes already succeeded —
	// the workflow result would otherwise look like a failure to Temporal
	// and trigger an unnecessary retry of the (already-complete) work.
	try {
		recordAudit({
			action: "audit.retention.purged",
			category: "audit",
			actor: { type: "system" },
			organizationId: null,
			outcome: "success",
			severity: "info",
			// Use the Temporal workflow `runId` as the correlation identity so
			// every audit row in this purge run is groupable from the viewer.
			correlationId: readActivityCorrelationId(),
			metadata: {
				deletedCount: totalDeleted,
				cutoffAt: cutoffAt.toISOString(),
				retentionDays,
				batches,
				hitSafetyCap,
			},
		});
	} catch (recordErr) {
		logger.warn(
			{
				event: "audit.retention.meta_event_failed",
				err:
					recordErr instanceof Error
						? { message: recordErr.message, name: recordErr.name }
						: String(recordErr),
			},
			"[AuditRetention] Failed to record meta-event after successful purge — continuing",
		);
	}

	return {
		deletedCount: totalDeleted,
		cutoffAt: cutoffAt.toISOString(),
		retentionDays,
		hitSafetyCap,
		withheldBySeal,
	};
}
