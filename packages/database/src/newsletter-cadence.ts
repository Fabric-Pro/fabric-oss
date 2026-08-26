export type NewsletterCadence = "WEEKLY" | "MONTHLY";

export interface NewsletterCadenceSettings {
	cadence: NewsletterCadence | string;
	dayOfWeek: number;
	dayOfMonth: number;
	sendHourUtc: number;
	lastSentAt: Date | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** ISO-8601 week number, e.g. "2026-W25". */
function isoWeek(date: Date): string {
	// Copy and shift to the nearest Thursday (ISO weeks are Thursday-anchored).
	const d = new Date(
		Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
	);
	const dayNum = (d.getUTCDay() + 6) % 7; // Mon=0..Sun=6
	d.setUTCDate(d.getUTCDate() - dayNum + 3);
	const firstThursday = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
	const week =
		1 +
		Math.round(
			((d.getTime() - firstThursday.getTime()) / DAY_MS -
				3 +
				((firstThursday.getUTCDay() + 6) % 7)) /
				7,
		);
	return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

export function periodBucket(
	cadence: NewsletterCadence | string,
	now: Date,
): string {
	if (cadence === "MONTHLY") {
		return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
	}
	return isoWeek(now);
}

export function scheduledDedupeKey(
	projectId: string,
	cadence: NewsletterCadence | string,
	now: Date,
): string {
	return `scheduled:${projectId}:${periodBucket(cadence, now)}`;
}

export function manualDedupeKey(projectId: string, windowEnd: Date): string {
	const floored = new Date(windowEnd);
	floored.setUTCSeconds(0, 0);
	return `manual:${projectId}:${floored.toISOString()}`;
}

/** True if the cadence + hour matches `now` AND we have not already sent today. */
export function isNewsletterDue(
	s: NewsletterCadenceSettings,
	now: Date,
): boolean {
	if (now.getUTCHours() !== s.sendHourUtc) {
		return false;
	}

	const dayMatches =
		s.cadence === "MONTHLY"
			? now.getUTCDate() === s.dayOfMonth
			: now.getUTCDay() === s.dayOfWeek;
	if (!dayMatches) {
		return false;
	}

	// Guard: do not re-send within the same UTC day.
	if (s.lastSentAt) {
		const startOfToday = new Date(
			Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
		);
		if (s.lastSentAt >= startOfToday) {
			return false;
		}
	}
	return true;
}

export function cadenceDefaultLookbackDays(
	cadence: NewsletterCadence | string,
): number {
	return cadence === "MONTHLY" ? 30 : 7;
}

/**
 * Collection window [start, now]. `lookbackDays` is the MINIMUM history covered.
 *   null -> incremental: lastSentAt ?? (now - fallbackDays)        (today's behavior)
 *   N    -> at least N days back, extended to lastSentAt on a gap  (min, catch-up)
 *
 * `fallbackDays` is caller-specific so the null path matches today exactly:
 *   manual    -> 7 (flat, matching the old 7-day default)
 *   scheduled -> cadenceDefaultLookbackDays(cadence) (7 weekly / 30 monthly)
 */
export function resolveWindow(
	s: { lookbackDays: number | null; lastSentAt: Date | null },
	now: Date,
	fallbackDays: number,
): { start: Date; end: Date } {
	const end = new Date(now);
	if (s.lookbackDays == null) {
		const fallback = new Date(now.getTime() - fallbackDays * DAY_MS);
		return { start: s.lastSentAt ? new Date(s.lastSentAt) : fallback, end };
	}
	const fixedStart = new Date(now.getTime() - s.lookbackDays * DAY_MS);
	const start =
		s.lastSentAt && s.lastSentAt.getTime() < fixedStart.getTime()
			? new Date(s.lastSentAt)
			: fixedStart;
	return { start, end };
}
