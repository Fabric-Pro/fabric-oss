/**
 * How often a project's pipeline results are fetched automatically (spec F1).
 *
 * The sweep itself stays a SINGLE deployment-wide Temporal schedule. A schedule
 * per project would need reconciling as projects are created, archived and
 * deleted — the `url-source-schedule-reconcile` problem again — so instead the
 * sweep ticks at a fixed rate and the enumerator treats each project's interval
 * as a **floor**. "Every 60 minutes" therefore means "no more often than
 * hourly", which is both simpler and self-healing: after an outage the next tick
 * catches everyone up rather than every project needing its schedule rebuilt.
 *
 * One module so the query that enforces the set, the procedure that validates
 * it, and the settings form that offers it cannot drift onto three different
 * ideas of what is allowed.
 */

/**
 * The intervals a customer may choose, in MINUTES.
 *
 * Minutes rather than a cron expression on purpose: a cron box invites
 * `* * * * *`, and a customer quietly DoSing their own CI provider is a support
 * incident that looks like a Fabric bug. A closed set also means the UI can be a
 * select rather than a validated free-text field.
 *
 * 15 is the floor because it matches the sweep's own tick — asking for anything
 * shorter could not be honoured anyway, and offering it would be a lie.
 */
export const PIPELINE_SYNC_INTERVAL_MINUTES = [15, 30, 60, 240] as const;

export type PipelineSyncIntervalMinutes =
	(typeof PIPELINE_SYNC_INTERVAL_MINUTES)[number];

/** Matches the column default, and the cadence the sweep shipped with. */
export const DEFAULT_PIPELINE_SYNC_INTERVAL_MINUTES = 15;

/**
 * Coerce a stored or submitted interval onto the closed set.
 *
 * A value outside the set can only arrive from a direct database edit or an
 * older client, and the honest response is the default rather than a crash: the
 * consequence of getting this wrong is syncing at the wrong rate, not data loss.
 */
export function normalisePipelineSyncInterval(
	minutes: number | null | undefined,
): PipelineSyncIntervalMinutes {
	return (PIPELINE_SYNC_INTERVAL_MINUTES as readonly number[]).includes(
		minutes ?? Number.NaN,
	)
		? (minutes as PipelineSyncIntervalMinutes)
		: DEFAULT_PIPELINE_SYNC_INTERVAL_MINUTES;
}

/**
 * Has this project's minimum interval elapsed since its last successful fetch?
 *
 * A project that has never fetched is always due — otherwise its very first
 * sync would wait an interval for no reason, and a newly connected repository
 * would look broken for an hour.
 *
 * Exported and tested directly: the boundary conditions ARE the behaviour.
 */
export function isPipelineSyncDue(input: {
	now: Date;
	lastFetchedAt: Date | null;
	/** Null when the project has no QA settings row — treated as the default. */
	intervalMinutes: number | null;
}): boolean {
	if (!input.lastFetchedAt) {
		return true;
	}
	const minutes = normalisePipelineSyncInterval(input.intervalMinutes);
	const elapsedMs = input.now.getTime() - input.lastFetchedAt.getTime();
	// `>=`, not `>`: at exactly the interval the project IS due. With a sweep
	// ticking on the same period as the shortest interval, `>` would make every
	// project miss its slot by milliseconds and sync at half the chosen rate.
	return elapsedMs >= minutes * 60_000;
}
