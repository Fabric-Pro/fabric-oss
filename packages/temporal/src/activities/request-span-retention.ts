/**
 * Request-Span Retention Activity
 *
 * Purges `request_span` rows older than `FABRIC_REQUEST_SPAN_RETENTION_DAYS`
 * (default 7 — the TTL stated in the data-retention-and-disposal policy) in
 * 5,000-row batches. Driven by the daily `requestSpanRetentionWorkflow`
 * (Temporal Schedule).
 *
 * Request spans are ephemeral debug data — persisted ONLY on request failure —
 * so retention is ON BY DEFAULT (unlike audit-log retention, which is opt-in to
 * avoid silently losing compliance history). `request_span` is a plain table
 * (not WORM), so the DELETE needs no bypass GUC.
 *
 * SOC 2 C1.2 (data retention / disposal).
 *
 * Behaviour:
 *  - `FABRIC_REQUEST_SPAN_RETENTION_DAYS` default 7; `0` (or unset-empty /
 *    non-finite / negative) `0` is an explicit retain-forever short-circuit
 *    (returns `{ deletedCount: 0 }` without deleting) so an operator can keep
 *    the schedule registered but pause purging.
 *  - Computes `cutoffAt` ONCE up front so a long run's window doesn't drift.
 *  - Batched raw DELETE with a `LIMIT` subquery; loops until a batch returns 0
 *    or the 1,000-batch safety cap (5M rows) fires.
 */

import { db } from "@repo/database";
import { logger } from "@repo/logs";

/** Batch size per DELETE statement. */
const BATCH_SIZE = 5_000;
/** Maximum batches per invocation. 1,000 × 5,000 = 5M rows hard cap. */
const MAX_BATCHES = 1_000;
/** Default retention window (days) — matches the data-retention policy TTL. */
const DEFAULT_RETENTION_DAYS = 7;
/** Clamp so an absurd value can't overflow the representable Date range. */
const MAX_RETENTION_DAYS = 36_500; // 100 years.

export interface PurgeExpiredRequestSpansResult {
	deletedCount: number;
	cutoffAt: string;
	retentionDays: number;
	hitSafetyCap: boolean;
}

/**
 * Read `FABRIC_REQUEST_SPAN_RETENTION_DAYS`. Defaults to 7. Unset / empty /
 * NaN falls back to the default; an explicit `0` (or negative) means
 * retain-forever. Clamped to `MAX_RETENTION_DAYS`.
 */
function readRetentionDays(): number {
	const raw = process.env.FABRIC_REQUEST_SPAN_RETENTION_DAYS;
	if (raw === undefined || raw === "") {
		return DEFAULT_RETENTION_DAYS;
	}
	const parsed = Number(raw);
	if (!Number.isFinite(parsed)) {
		return DEFAULT_RETENTION_DAYS;
	}
	if (parsed <= 0) {
		return 0; // explicit retain-forever
	}
	return Math.min(MAX_RETENTION_DAYS, Math.floor(parsed));
}

export async function purgeExpiredRequestSpansActivity(): Promise<PurgeExpiredRequestSpansResult> {
	const retentionDays = readRetentionDays();

	if (retentionDays <= 0) {
		logger.info(
			{
				event: "request_span.retention.skipped",
				reason: "retention_days_zero",
			},
			"[RequestSpanRetention] FABRIC_REQUEST_SPAN_RETENTION_DAYS=0 — retain forever, skipping purge",
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
			event: "request_span.retention.started",
			retentionDays,
			cutoffAt: cutoffAt.toISOString(),
		},
		"[RequestSpanRetention] Starting purge run",
	);

	while (batches < MAX_BATCHES) {
		// `request_span` is a plain table (not WORM) so no bypass GUC is needed.
		// The `LIMIT` subquery lets each batch scan only the index head.
		const affected = await db.$executeRaw`
			DELETE FROM "request_span"
			WHERE "id" IN (
				SELECT "id" FROM "request_span"
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
				event: "request_span.retention.safety_cap_hit",
				maxBatches: MAX_BATCHES,
				batchSize: BATCH_SIZE,
				deletedCount: totalDeleted,
				retentionDays,
				cutoffAt: cutoffAt.toISOString(),
			},
			`[RequestSpanRetention] Safety cap hit after ${MAX_BATCHES} batches (${totalDeleted} rows). Remaining rows purge on the next run.`,
		);
	}

	logger.info(
		{
			event: "request_span.retention.completed",
			deletedCount: totalDeleted,
			retentionDays,
			cutoffAt: cutoffAt.toISOString(),
			batches,
			hitSafetyCap,
		},
		`[RequestSpanRetention] Purged ${totalDeleted} request_span rows older than ${cutoffAt.toISOString()}`,
	);

	return {
		deletedCount: totalDeleted,
		cutoffAt: cutoffAt.toISOString(),
		retentionDays,
		hitSafetyCap,
	};
}
