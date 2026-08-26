/**
 * Occurrence-day resolution for pre-meeting agendas (#1901).
 *
 * Agenda identity is (linkedMeetingId, occurrenceStart), but both reads and
 * generation resolve on the UTC DAY, so a meeting moved from 10:00 to 14:00
 * keeps its agenda instead of forking into a second row.
 *
 * Caveat: a meeting recurring twice within one UTC day would share one agenda.
 * No such meeting exists in current usage.
 *
 * This lives in its own module rather than in agenda.ts because
 * list-upcoming-meetings.ts needs the same rule to decide which agenda belongs
 * to which calendar occurrence (#2106). If the two drifted, the digest's
 * checklist indicator would disagree with the agenda sheet it opens.
 */

/** Half-open [start of UTC day, start of next UTC day) — a Prisma range filter. */
export function utcDayRange(date: Date): { gte: Date; lt: Date } {
	const gte = new Date(
		Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
	);
	const lt = new Date(gte.getTime() + 24 * 60 * 60 * 1000);
	return { gte, lt };
}

/** The same rule as `utcDayRange`, as a `yyyy-MM-dd` key for map lookups. */
export function utcDayKey(date: Date): string {
	return date.toISOString().slice(0, 10);
}
