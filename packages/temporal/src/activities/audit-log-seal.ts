/**
 * Audit Log Sealing Activity
 *
 * Advances the audit_log tamper-evidence seal chain by one link. Driven by the
 * hourly `auditLogSealWorkflow` (Temporal Schedule). All the crypto + DB work
 * lives in `@repo/database` (`sealNextAuditWindow`); this activity is the
 * side-effecting boundary that reads env, invokes it, and logs the outcome.
 *
 * Behaviour:
 *  - Reads `FABRIC_AUDIT_LOG_SEAL_LAG_SECONDS` (default 300) at activity start.
 *    A window is only sealed up to `now - lag` so any audit insert still in
 *    flight (including one committing from a longer-lived request transaction,
 *    whose createdAt is the transaction-start time) has landed before its
 *    window closes.
 *  - The genesis run seals all history (periodStart = epoch); every later run
 *    seals `[previous.periodEnd, now - lag)`. A zero-width window is a no-op.
 *  - Never touches the audit insert hot path; `recordAudit` stays fast.
 *
 * Idempotency: safe under Temporal retries. The `audit_log_seal.sequence`
 * unique constraint means a retry that races a committed prior attempt fails on
 * insert rather than double-sealing; the next scheduled run continues the chain.
 *
 * See: docs/audit-log/README.md §10
 */

import { type SealRunResult, sealNextAuditWindow } from "@repo/database";
import { logger } from "@repo/logs";

// Re-export so the workflow can type its return value without reaching into
// @repo/database directly (mirrors the retention activity/workflow split).
export type { SealRunResult };

/** Default safety lag in seconds; overridable via env. Mirrors the DB default. */
const DEFAULT_LAG_SECONDS = 300;
/**
 * Clamp the lag to a sane ceiling so a fat-fingered env value can't push the
 * window cutoff so far into the past that sealing never makes progress.
 */
const MAX_LAG_SECONDS = 86_400; // 24h

function readLagSeconds(): number {
	const raw = process.env.FABRIC_AUDIT_LOG_SEAL_LAG_SECONDS;
	if (raw === undefined || raw === "") {
		return DEFAULT_LAG_SECONDS;
	}
	const parsed = Number(raw);
	if (!Number.isFinite(parsed) || parsed < 0) {
		return DEFAULT_LAG_SECONDS;
	}
	return Math.min(MAX_LAG_SECONDS, Math.floor(parsed));
}

/** Seal the next audit-log window. Returns the DB layer's run result. */
export async function sealAuditLogActivity(): Promise<SealRunResult> {
	const lagSeconds = readLagSeconds();

	logger.info(
		{ event: "audit.seal.started", lagSeconds },
		"[AuditSeal] Sealing next audit-log window",
	);

	const result = await sealNextAuditWindow({ lagSeconds });

	if (!result.created) {
		logger.info(
			{ event: "audit.seal.skipped", reason: result.reason },
			"[AuditSeal] No window to seal this run",
		);
		return result;
	}

	logger.info(
		{
			event: "audit.seal.created",
			sequence: result.sequence,
			rowCount: result.rowCount,
			periodStart: result.periodStart,
			periodEnd: result.periodEnd,
			keyId: result.keyId,
		},
		`[AuditSeal] Sealed ${result.rowCount} audit_log rows as seal #${result.sequence}`,
	);

	return result;
}
