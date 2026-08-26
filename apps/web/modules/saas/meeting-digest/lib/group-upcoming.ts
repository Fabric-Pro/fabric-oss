import { addDays, format, isSameDay } from "date-fns";
import type { UpcomingMeeting } from "../hooks/use-upcoming-meetings";
import { dayKey } from "./group-meetings";

export interface UpcomingDayGroup {
	/** `yyyy-MM-dd` in the viewer's local zone. */
	key: string;
	/** "Today" | "Tomorrow" | "Wednesday, 29 Jul" */
	label: string;
	meetings: UpcomingMeeting[];
}

function dayLabel(date: Date, now: Date): string {
	if (isSameDay(date, now)) {
		return "Today";
	}
	if (isSameDay(date, addDays(now, 1))) {
		return "Tomorrow";
	}
	return format(date, "EEEE, d MMM");
}

/**
 * Bucket upcoming calendar occurrences under day headers (#2106, FR1).
 *
 * Buckets on the viewer's LOCAL calendar day, via the same `dayKey` the digest's
 * other groupers use, so all three share one key space. Note this is
 * deliberately not the UTC day that agenda occurrence identity resolves on: a
 * user in UTC+3 expects their 01:00 meeting under tomorrow's header, not under
 * today's.
 *
 * Days with no meetings never appear (D3) — a 14-day window otherwise fills with
 * empty weekend headers that push real content off screen.
 *
 * A meeting with a missing or unparseable start time is dropped rather than
 * bucketed under a fallback date, the same rule `groupPersonalMeetingsByDay`
 * applies: showing a meeting on the wrong day is worse than not showing it.
 *
 * `now` is injected rather than read from the clock so "Today"/"Tomorrow" are
 * testable.
 */
export function groupUpcomingByDay(
	meetings: UpcomingMeeting[],
	now: Date,
): UpcomingDayGroup[] {
	const buckets = new Map<
		string,
		{ date: Date; meetings: UpcomingMeeting[] }
	>();

	for (const meeting of meetings) {
		if (!meeting.startTime) {
			continue;
		}
		const date = new Date(meeting.startTime);
		if (Number.isNaN(date.getTime())) {
			continue;
		}
		const key = dayKey(date);
		const bucket = buckets.get(key);
		if (bucket) {
			bucket.meetings.push(meeting);
		} else {
			buckets.set(key, { date, meetings: [meeting] });
		}
	}

	return [...buckets.entries()]
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([key, bucket]) => ({
			key,
			label: dayLabel(bucket.date, now),
			meetings: [...bucket.meetings].sort((a, b) =>
				a.startTime.localeCompare(b.startTime),
			),
		}));
}

/**
 * Merge the near and later day chunks into one list (#2106, FR2).
 *
 * Deduped on (joinUrl, startTime) — the same identity the list's React keys use.
 * Graph's calendarView bounds are inclusive at the start, so a meeting sitting
 * exactly on the chunk boundary is returned by both requests. A recurring series
 * shares a joinUrl across occurrences, so the start time has to be part of the
 * key or the merge would collapse a whole series into one row.
 */
export function mergeUpcomingChunks(
	near: UpcomingMeeting[],
	later: UpcomingMeeting[],
): UpcomingMeeting[] {
	const byOccurrence = new Map<string, UpcomingMeeting>();
	for (const meeting of [...near, ...later]) {
		const key = `${meeting.joinUrl}:${meeting.startTime}`;
		if (!byOccurrence.has(key)) {
			byOccurrence.set(key, meeting);
		}
	}
	return [...byOccurrence.values()].sort((a, b) =>
		a.startTime.localeCompare(b.startTime),
	);
}
