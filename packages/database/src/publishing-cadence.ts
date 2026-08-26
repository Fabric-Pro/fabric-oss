/**
 * Cadence maths for Publishing Suite suggestion generation.
 *
 * Modelled on `document-refresh-cadence.ts`: the interval has ELAPSED since the
 * last completed run, rather than firing on a configured weekday like
 * `newsletter-cadence.ts`. Cadence stays a plain string with a TS union (not a
 * Prisma enum) for the same reason stated there — adding a value later costs no
 * enum migration.
 *
 * The one deliberate departure from `isRefreshDue` is that this compares whole
 * UTC DATES rather than elapsed milliseconds. The publishing dispatcher fires at
 * a FIXED time (06:00 UTC daily), so an elapsed-ms comparison drifts: a run at
 * 06:00:00.000 followed by a tick a few milliseconds early reads as 6d23h59m,
 * defers a day, and then reads 8 days — pushing the run later every period.
 * Document refresh hides that under up to 24h of per-entity jitter; this does
 * not need jitter (a once-daily tick makes sub-24h jitter a no-op), so it must
 * not have the drift either.
 *
 * Whole-date comparison is not free, though: "N days" means "N calendar-date
 * boundaries crossed", not "N times 24 elapsed hours". When `lastStartedAt`'s
 * time-of-day is LATER than the tick's, a boundary gets crossed before a full
 * interval of wall-clock time has actually passed. A run at
 * 2026-08-04T23:00:00Z and a tick at 2026-08-11T01:00:00Z cross 7 date
 * boundaries and read as due after only 146 of the 168 hours a week contains
 * — up to nearly a full day early in the worst case. That is accepted as the
 * lesser of two errors: an elapsed-ms comparison drifts a little later every
 * period until it eventually skips one outright, and skipping a scheduled
 * period is worse than starting the next one a bit early.
 *
 * The skew is also bounded and self-correcting rather than something that
 * accumulates. A run that comes from the scheduled dispatcher tick re-anchors
 * `lastStartedAt` to the tick hour, so misalignment can only be introduced by
 * a run that did NOT originate from the tick — a manual trigger, or a
 * project's first run ever — and it is gone again as soon as the next
 * scheduled run re-anchors the timestamp. An early scheduled run is not an
 * uncontrolled cost either: it still has to clear the dispatcher's cost guard
 * and the workflow's own freshness gate before it does any work, so the worst
 * case is "up to a day early", never "unbounded".
 */

export type PublishingCadence = "MANUAL" | "WEEKLY" | "BIWEEKLY" | "MONTHLY";

export const PUBLISHING_CADENCES = [
	"MANUAL",
	"WEEKLY",
	"BIWEEKLY",
	"MONTHLY",
] as const satisfies readonly PublishingCadence[];

export const DEFAULT_PUBLISHING_CADENCE: PublishingCadence = "MANUAL";

/** Bounds for the per-project lookback override. `null` means "engine default". */
export const MIN_PUBLISHING_LOOKBACK_DAYS = 1;
export const MAX_PUBLISHING_LOOKBACK_DAYS = 365;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Days between scheduled runs, or `null` for a cadence that never fires on a
 * schedule.
 *
 * An unrecognised value falls back to 7 days rather than throwing or treating
 * it as `MANUAL`: a corrupt settings row must not be able to wedge the whole
 * sweep (same defensive choice as `refreshIntervalDays`). This is no longer
 * "falls back to the default" now that the default cadence is `MANUAL` — the
 * two have deliberately diverged. An unrecognised value is most likely a
 * newer cadence written by a newer app version during a rollout, and every
 * cadence other than `MANUAL` fires on *some* schedule, so approximating it
 * as weekly is safer than silently never running the project again.
 */
export function cadenceIntervalDays(
	cadence: PublishingCadence | string,
): number | null {
	switch (cadence) {
		case "MANUAL":
			return null;
		case "WEEKLY":
			return 7;
		case "BIWEEKLY":
			return 14;
		case "MONTHLY":
			return 30;
		default:
			return 7;
	}
}

/** Whole days between two instants, counting UTC calendar dates only. */
function utcDaysBetween(from: Date, to: Date): number {
	const startOfDay = (d: Date) =>
		Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
	return Math.floor((startOfDay(to) - startOfDay(from)) / MS_PER_DAY);
}

/**
 * True when a project is due for a scheduled suggestion cycle.
 *
 * `lastStartedAt` is the `startedAt` of the newest cycle that COUNTS AS A RUN —
 * see the query in `find-eligible-projects.ts`. A project that has never had one
 * is due immediately.
 */
export function isPublishingCycleDue(
	settings: { cadence: PublishingCadence | string },
	lastStartedAt: Date | null,
	now: Date,
): boolean {
	const intervalDays = cadenceIntervalDays(settings.cadence);
	if (intervalDays === null) {
		return false;
	}
	if (!lastStartedAt) {
		return true;
	}
	return utcDaysBetween(lastStartedAt, now) >= intervalDays;
}

/**
 * Does a terminal cycle COUNT AS A RUN?
 *
 * The TypeScript twin of the raw-SQL predicate inside
 * `getLastCountedPublishingRuns`. Two uses, one rule: a cycle that counts as a
 * run defers the next cadence tick, and a cycle that counts as a run records the
 * preferences it ran with. They must be the same set or the fingerprint develops
 * a hole — a terminal that defers cadence but records no hash would show a
 * mismatch at every later due date, turning "reprocess exactly once" into
 * "reprocess every period, forever".
 *
 * A dirty INSUFFICIENT_CONTEXT does not count: a collector failed, and the
 * source that might have tipped the project over the sufficiency threshold
 * deserves a retry rather than a month of silence.
 *
 * "Clean" is `sourceFailures` null OR the empty object — the workflow
 * initialises it to `{}` and persists that verbatim, so a null-only test would
 * match nothing.
 */
export function publishingTerminalCountsAsRun(args: {
	status: "READY" | "NO_TOPICS" | "INSUFFICIENT_CONTEXT";
	sourceFailures: Record<string, unknown> | null | undefined;
}): boolean {
	if (args.status !== "INSUFFICIENT_CONTEXT") {
		return true;
	}
	return (
		args.sourceFailures == null ||
		Object.keys(args.sourceFailures).length === 0
	);
}
