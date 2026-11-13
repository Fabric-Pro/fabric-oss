/**
 * Wall-clock times in a named IANA zone, for start/stop entries.
 *
 * The API takes `startAt`/`stopAt` as ISO instants WITH an offset and computes
 * the duration from them, so the offset has to be the zone's offset at that
 * date and time, not the browser's and not today's: an entry typed for a
 * Berlin morning in March must carry +01:00 before the clocks change and
 * +02:00 after.
 */

import { addDays } from "@repo/utils/time-tracking";

const formatters = new Map<string, Intl.DateTimeFormat>();

function wallClockFormatter(timeZone: string): Intl.DateTimeFormat {
	const cached = formatters.get(timeZone);
	if (cached) {
		return cached;
	}
	const formatter = new Intl.DateTimeFormat("en-US", {
		timeZone,
		hourCycle: "h23",
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
	});
	formatters.set(timeZone, formatter);
	return formatter;
}

interface WallClock {
	date: string;
	time: string;
	/** The wall clock read as if it were UTC, in milliseconds. */
	asUtcMs: number;
}

function wallClockAt(utcMs: number, timeZone: string): WallClock {
	const parts: Record<string, string> = {};
	for (const part of wallClockFormatter(timeZone).formatToParts(
		new Date(utcMs),
	)) {
		parts[part.type] = part.value;
	}
	const year = Number(parts.year);
	const month = Number(parts.month);
	const day = Number(parts.day);
	const hour = Number(parts.hour);
	const minute = Number(parts.minute);
	const second = Number(parts.second);
	return {
		date: `${parts.year}-${parts.month}-${parts.day}`,
		time: `${parts.hour}:${parts.minute}`,
		asUtcMs: Date.UTC(year, month - 1, day, hour, minute, second),
	};
}

/** Minutes the zone is ahead of UTC at this instant (Berlin in winter: 60). */
function offsetMinutesAt(utcMs: number, timeZone: string): number {
	const wholeSecondMs = Math.floor(utcMs / 1000) * 1000;
	return Math.round(
		(wallClockAt(wholeSecondMs, timeZone).asUtcMs - wholeSecondMs) / 60_000,
	);
}

function formatOffset(offsetMinutes: number): string {
	const sign = offsetMinutes < 0 ? "-" : "+";
	const absolute = Math.abs(offsetMinutes);
	const hours = String(Math.floor(absolute / 60)).padStart(2, "0");
	const minutes = String(absolute % 60).padStart(2, "0");
	return `${sign}${hours}:${minutes}`;
}

const TIME_OF_DAY = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** `HH:MM` on a 24-hour clock, as `<input type="time">` produces it. */
export function isTimeOfDay(value: string): boolean {
	return TIME_OF_DAY.test(value);
}

/**
 * The instant a wall-clock `date` + `time` names in `timeZone`, as an ISO
 * string with that zone's offset at the time (`2026-03-29T04:00:00+02:00`).
 *
 * A time the clocks skip (02:30 on a spring-forward night) has no instant; it
 * is read under the offset in force before the change, which lands it the
 * same distance after the gap (03:30).
 */
export function zonedWallClockToIso(params: {
	date: string;
	time: string;
	timeZone: string;
}): string {
	const [hours, minutes] = params.time.split(":").map(Number);
	const [year, month, day] = params.date.split("-").map(Number);
	const wallAsUtc = Date.UTC(year, month - 1, day, hours, minutes);

	const firstGuess = offsetMinutesAt(wallAsUtc, params.timeZone);
	const secondGuess = offsetMinutesAt(
		wallAsUtc - firstGuess * 60_000,
		params.timeZone,
	);
	const roundTrips = [firstGuess, secondGuess].find(
		(guess) =>
			offsetMinutesAt(wallAsUtc - guess * 60_000, params.timeZone) ===
			guess,
	);
	const instant =
		wallAsUtc - (roundTrips ?? Math.min(firstGuess, secondGuess)) * 60_000;

	const offset = offsetMinutesAt(instant, params.timeZone);
	const local = new Date(instant + offset * 60_000)
		.toISOString()
		.slice(0, 19);
	return `${local}${formatOffset(offset)}`;
}

/**
 * `startAt` and `stopAt` for a start/stop entry. The stop falls on the work
 * date or, for work that ran past midnight, on the next day.
 */
export function buildStartStopInstants(params: {
	workDate: string;
	startTime: string;
	stopTime: string;
	stopsNextDay: boolean;
	timeZone: string;
}): { startAt: string; stopAt: string } {
	return {
		startAt: zonedWallClockToIso({
			date: params.workDate,
			time: params.startTime,
			timeZone: params.timeZone,
		}),
		stopAt: zonedWallClockToIso({
			date: params.stopsNextDay
				? addDays(params.workDate, 1)
				: params.workDate,
			time: params.stopTime,
			timeZone: params.timeZone,
		}),
	};
}

/** Minutes between two ISO instants, or `null` when stop is not after start. */
export function minutesBetween(startAt: string, stopAt: string): number | null {
	const elapsed = Date.parse(stopAt) - Date.parse(startAt);
	return elapsed > 0 ? Math.round(elapsed / 60_000) : null;
}

/** The wall-clock date and `HH:MM` of an instant in `timeZone`. */
export function wallClockInZone(
	instant: string,
	timeZone: string,
): { date: string; time: string } {
	const { date, time } = wallClockAt(Date.parse(instant), timeZone);
	return { date, time };
}

/** Today's `YYYY-MM-DD` in `timeZone`. */
export function todayInZone(timeZone: string, now: Date = new Date()): string {
	return wallClockAt(now.getTime(), timeZone).date;
}

/** The zone the browser runs in, or UTC when it cannot say. */
export function browserTimeZone(): string {
	return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

/**
 * The zone a new entry starts in: the one on the member's profile (the API
 * sends it only when it is a real IANA zone), else the browser's.
 */
export function newEntryTimeZone(
	profileTimeZone: string | null | undefined,
	browserZone: string,
): string {
	return profileTimeZone ?? browserZone;
}
