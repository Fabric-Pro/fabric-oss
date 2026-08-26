/**
 * Audit Log Retention Env Validation
 *
 * Reads `FABRIC_AUDIT_LOG_RETENTION_DAYS` and emits a non-fatal warning
 * when the operator chose a value below the 90-day documented minimum.
 * Called at worker startup so the warning lands on the same log surface
 * the operator sees during a manual restart.
 *
 * Behaviour (per spec §9.5):
 *  - `unset` / `""` / `"0"` -> no warning (retain forever is fine)
 *  - `90` and above -> no warning
 *  - `1..89` -> warning (operator override still applies)
 *  - non-numeric / negative -> no warning (the activity short-circuits)
 *
 * The warning is intentionally a `console.warn` rather than an exception:
 * the operator is allowed to configure a shorter window, but
 * compliance-sensitive deployments expect at least 90 days for diagnostic
 * coverage and we want the deviation to be visible at boot.
 *
 * See: docs/audit-log/README.md §9.5
 */

const RETENTION_FLOOR_DAYS = 90;

/**
 * Emit a non-fatal warning if FABRIC_AUDIT_LOG_RETENTION_DAYS is set
 * below the 90-day documented floor. Safe to call multiple times — the
 * warning is informational only.
 */
export function validateAuditRetentionDays(
	log: (msg: string) => void = console.warn,
): void {
	const raw = process.env.FABRIC_AUDIT_LOG_RETENTION_DAYS;
	if (raw === undefined || raw === "") {
		return;
	}
	const value = Number(raw);
	if (!Number.isFinite(value) || value <= 0) {
		return;
	}
	if (value >= RETENTION_FLOOR_DAYS) {
		return;
	}

	log(
		`[env] FABRIC_AUDIT_LOG_RETENTION_DAYS=${value} is below the documented minimum (${RETENTION_FLOOR_DAYS}). Audit retention is configurable but compliance-sensitive deployments expect at least ${RETENTION_FLOOR_DAYS} days for diagnostic coverage.`,
	);
}
