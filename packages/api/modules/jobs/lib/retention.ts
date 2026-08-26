/**
 * Job Hub retention window.
 *
 * Finished jobs stay visible in the panel for this many days; the
 * `background-job-retention` Temporal schedule deletes them on the same
 * boundary, so the list query and the purge must read the same value.
 *
 * The PM decision was "1–7 days, exact figure a dev call based on volume": 7 is
 * the default because a user who returns from a long weekend should still see
 * what happened while they were away, and the table is bounded by the purge.
 * `FABRIC_JOB_RETENTION_DAYS` narrows it if volume proves that too generous.
 */

const DEFAULT_JOB_RETENTION_DAYS = 7;
const MIN_JOB_RETENTION_DAYS = 1;
const MAX_JOB_RETENTION_DAYS = 30;

export function getJobRetentionDays(): number {
	const raw = process.env.FABRIC_JOB_RETENTION_DAYS;
	if (!raw) {
		return DEFAULT_JOB_RETENTION_DAYS;
	}
	const parsed = Number.parseInt(raw.trim(), 10);
	if (!Number.isFinite(parsed)) {
		return DEFAULT_JOB_RETENTION_DAYS;
	}
	return Math.min(
		MAX_JOB_RETENTION_DAYS,
		Math.max(MIN_JOB_RETENTION_DAYS, parsed),
	);
}
