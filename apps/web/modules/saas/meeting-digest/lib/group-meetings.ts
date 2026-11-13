import {
	eachDayOfInterval,
	endOfMonth,
	endOfWeek,
	format,
	startOfMonth,
	startOfWeek,
} from "date-fns";
import type { AwaitingMeeting, DigestMeeting, PersonalMeeting } from "./types";

const DAY_KEY = "yyyy-MM-dd";

/**
 * The calendar day a meeting was held, as a local date to group and show.
 *
 * A date with no time of day, one read from a file or typed in by a person
 * (#3507), is stored at exactly 12:00:00.000 UTC and means that calendar day
 * for every viewer, so it is read in UTC; read as an instant it falls on the
 * next day east of UTC+12. A real timestamp, which never lands on that exact
 * millisecond in practice, is read in the viewer's zone as before.
 */
export function meetingCalendarDay(date: Date | string): Date {
	const d = new Date(date);
	if (
		d.getUTCHours() === 12 &&
		d.getUTCMinutes() === 0 &&
		d.getUTCSeconds() === 0 &&
		d.getUTCMilliseconds() === 0
	) {
		return new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
	}
	return d;
}

/** Bucket meetings by calendar day; meetings without a date are dropped. */
export function groupMeetingsByDay(
	meetings: DigestMeeting[],
): Map<string, DigestMeeting[]> {
	const out = new Map<string, DigestMeeting[]>();
	for (const meeting of meetings) {
		if (!meeting.meetingDate) {
			continue;
		}
		const key = format(meetingCalendarDay(meeting.meetingDate), DAY_KEY);
		const bucket = out.get(key);
		if (bucket) {
			bucket.push(meeting);
		} else {
			out.set(key, [meeting]);
		}
	}
	for (const bucket of out.values()) {
		bucket.sort((a, b) => {
			const timeA = a.meetingDate ? new Date(a.meetingDate).getTime() : 0;
			const timeB = b.meetingDate ? new Date(b.meetingDate).getTime() : 0;
			return timeA - timeB;
		});
	}
	return out;
}

/** Whole-week-aligned day grid covering the given month (for a 7-col calendar). */
export function monthGridDays(monthDate: Date): Date[] {
	return eachDayOfInterval({
		start: startOfWeek(startOfMonth(monthDate)),
		end: endOfWeek(endOfMonth(monthDate)),
	});
}

export const dayKey = (d: Date): string => format(d, DAY_KEY);

/**
 * Bucket awaiting-transcript occurrences by day, using the same `dayKey` the
 * project and personal groupers use so all three share one key space (#2051).
 *
 * Unparseable occurrences are dropped for the same reason
 * `groupPersonalMeetingsByDay` drops them: showing a meeting on the wrong day
 * is worse than not showing it.
 */
export function groupAwaitingByDay(
	meetings: AwaitingMeeting[],
): Map<string, AwaitingMeeting[]> {
	const map = new Map<string, AwaitingMeeting[]>();
	for (const meeting of meetings) {
		const date = new Date(meeting.occurrenceStart);
		if (Number.isNaN(date.getTime())) {
			continue;
		}
		const key = dayKey(date);
		const bucket = map.get(key);
		if (bucket) {
			bucket.push(meeting);
		} else {
			map.set(key, [meeting]);
		}
	}
	for (const bucket of map.values()) {
		bucket.sort((a, b) => {
			const timeA = new Date(a.occurrenceStart).getTime();
			const timeB = new Date(b.occurrenceStart).getTime();
			return timeA - timeB;
		});
	}
	return map;
}

/**
 * Bucket personal calendar meetings by day, using the same `dayKey` the
 * project-meeting grouper uses so both maps share a key space (#1899).
 *
 * Meetings with a missing or unparseable start time are dropped rather than
 * bucketed under a fallback date — showing a meeting on the wrong day is worse
 * than not showing it, and the Graph calendar always supplies a start for a
 * real event.
 */
export function groupPersonalMeetingsByDay(
	meetings: PersonalMeeting[],
): Map<string, PersonalMeeting[]> {
	const map = new Map<string, PersonalMeeting[]>();
	for (const meeting of meetings) {
		if (!meeting.startTime) {
			continue;
		}
		const date = new Date(meeting.startTime);
		if (Number.isNaN(date.getTime())) {
			continue;
		}
		const key = dayKey(date);
		const bucket = map.get(key);
		if (bucket) {
			bucket.push(meeting);
		} else {
			map.set(key, [meeting]);
		}
	}
	for (const bucket of map.values()) {
		bucket.sort((a, b) => {
			const timeA = a.startTime ? new Date(a.startTime).getTime() : 0;
			const timeB = b.startTime ? new Date(b.startTime).getTime() : 0;
			return timeA - timeB;
		});
	}
	return map;
}
