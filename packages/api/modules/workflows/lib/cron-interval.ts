import { CronExpressionParser } from "cron-parser";

/** How many consecutive fires to compare; enough to see every gap in a repeating pattern. */
const SAMPLE_SIZE = 120;
const REFERENCE_DATE = new Date("2026-01-01T00:00:00Z");
const MS_PER_MINUTE = 60_000;
const MAX_SPAN_MS = 366 * 24 * 60 * MS_PER_MINUTE;

/**
 * The shortest gap, in minutes, between two fires of a schedule's cron.
 *
 * Returns `Infinity` for a cron that fires at most once, and null when the
 * expression cannot be evaluated, so a caller that must bound the interval can
 * refuse what it cannot measure.
 *
 * Temporal's six-field form puts a year last (not seconds first, as
 * `cron-parser` reads six fields), so only the first five fields are
 * evaluated; a year restriction can only make fires rarer.
 */
export function minimumCronIntervalMinutes(cron: string): number | null {
	if (!cron.trim()) {
		return null;
	}
	const expression = cron.trim().split(/\s+/).slice(0, 5).join(" ");

	let schedule: ReturnType<typeof CronExpressionParser.parse>;
	try {
		schedule = CronExpressionParser.parse(expression, {
			currentDate: REFERENCE_DATE,
			tz: "UTC",
		});
	} catch {
		return null;
	}

	let first: number | null = null;
	let previous: number | null = null;
	let smallest = Number.POSITIVE_INFINITY;
	for (let fire = 0; fire < SAMPLE_SIZE; fire++) {
		let current: number;
		try {
			current = schedule.next().toDate().getTime();
		} catch {
			break;
		}
		first ??= current;
		if (previous !== null) {
			smallest = Math.min(smallest, current - previous);
		}
		previous = current;
		// A burst of close fires shows up right after the first one, so a
		// pattern that repeats less than yearly needs no more samples; looking
		// further is slow for ones such as 29 February.
		if (current - first > MAX_SPAN_MS) {
			break;
		}
	}
	return smallest / MS_PER_MINUTE;
}
