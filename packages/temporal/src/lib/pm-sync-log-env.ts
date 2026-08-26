/**
 * PM Sync Log Retention Env Validation
 *
 * Reads `FABRIC_PM_SYNC_LOG_RETENTION_DAYS` and emits a non-fatal warning
 * when the operator chose a value below the 90-day documented minimum.
 * Called at worker startup so the warning lands on the same log surface
 * the operator sees during a manual restart. Mirrors `audit-log-env.ts`.
 *
 * Behaviour (per spec §7.2):
 *  - `unset` / `""` / `"0"` -> no warning (retain forever is fine)
 *  - `90` and above -> no warning
 *  - `1..89` -> warning (operator override still applies)
 *  - non-numeric / negative -> no warning (the activity short-circuits)
 *
 * The warning is intentionally a `console.warn` rather than an exception:
 * the operator is allowed to configure a shorter window, but we want a
 * sub-floor retention to be visible at boot since it shrinks the Sync
 * History diagnostic window.
 */

const RETENTION_FLOOR_DAYS = 90;

/**
 * Emit a non-fatal warning if FABRIC_PM_SYNC_LOG_RETENTION_DAYS is set
 * below the 90-day documented floor. Safe to call multiple times — the
 * warning is informational only.
 */
export function validatePmSyncLogRetentionDays(
	log: (msg: string) => void = console.warn,
): void {
	const raw = process.env.FABRIC_PM_SYNC_LOG_RETENTION_DAYS;
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
		`[env] FABRIC_PM_SYNC_LOG_RETENTION_DAYS=${value} is below the documented minimum (${RETENTION_FLOOR_DAYS}). PM sync-log retention is configurable but a shorter window shrinks the Sync History diagnostic coverage; at least ${RETENTION_FLOOR_DAYS} days is recommended.`,
	);
}
