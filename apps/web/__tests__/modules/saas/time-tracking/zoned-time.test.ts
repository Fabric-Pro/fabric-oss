/**
 * Start/stop entries are sent as ISO instants with the zone's offset at that
 * date and time. These pin the offsets the server would otherwise compute a
 * wrong duration from: an ordinary day, work past midnight, both
 * daylight-saving changes, and a zone west of UTC.
 */

import {
	buildStartStopInstants,
	isTimeOfDay,
	minutesBetween,
	newEntryTimeZone,
	todayInZone,
	wallClockInZone,
	zonedWallClockToIso,
} from "@saas/time-tracking/lib/zoned-time";
import { describe, expect, it } from "vitest";

describe("zonedWallClockToIso", () => {
	it("uses the winter offset in Berlin", () => {
		expect(
			zonedWallClockToIso({
				date: "2026-11-11",
				time: "09:15",
				timeZone: "Europe/Berlin",
			}),
		).toBe("2026-11-11T09:15:00+01:00");
	});

	it("uses the summer offset in Berlin", () => {
		expect(
			zonedWallClockToIso({
				date: "2026-07-01",
				time: "09:15",
				timeZone: "Europe/Berlin",
			}),
		).toBe("2026-07-01T09:15:00+02:00");
	});

	it("writes a negative offset for a zone west of UTC", () => {
		expect(
			zonedWallClockToIso({
				date: "2026-11-11",
				time: "17:00",
				timeZone: "America/New_York",
			}),
		).toBe("2026-11-11T17:00:00-05:00");
	});

	it("writes +00:00 for UTC", () => {
		expect(
			zonedWallClockToIso({
				date: "2026-11-11",
				time: "00:00",
				timeZone: "UTC",
			}),
		).toBe("2026-11-11T00:00:00+00:00");
	});

	it("moves a time the clocks skip to just after the gap", () => {
		// Berlin goes from 02:00 straight to 03:00 on 29 March 2026.
		expect(
			zonedWallClockToIso({
				date: "2026-03-29",
				time: "02:30",
				timeZone: "Europe/Berlin",
			}),
		).toBe("2026-03-29T03:30:00+02:00");
	});
});

describe("buildStartStopInstants", () => {
	it("puts an overnight stop on the next day", () => {
		const instants = buildStartStopInstants({
			workDate: "2026-11-11",
			startTime: "22:00",
			stopTime: "01:30",
			stopsNextDay: true,
			timeZone: "Europe/Berlin",
		});

		expect(instants).toEqual({
			startAt: "2026-11-11T22:00:00+01:00",
			stopAt: "2026-11-12T01:30:00+01:00",
		});
		expect(minutesBetween(instants.startAt, instants.stopAt)).toBe(210);
	});

	it("counts the hour the clocks skip on the spring-forward day", () => {
		const instants = buildStartStopInstants({
			workDate: "2026-03-29",
			startTime: "01:00",
			stopTime: "04:00",
			stopsNextDay: false,
			timeZone: "Europe/Berlin",
		});

		expect(instants).toEqual({
			startAt: "2026-03-29T01:00:00+01:00",
			stopAt: "2026-03-29T04:00:00+02:00",
		});
		expect(minutesBetween(instants.startAt, instants.stopAt)).toBe(120);
	});

	it("counts the repeated hour on the fall-back day", () => {
		// Berlin repeats 02:00–03:00 on 25 October 2026.
		const instants = buildStartStopInstants({
			workDate: "2026-10-25",
			startTime: "00:00",
			stopTime: "06:00",
			stopsNextDay: false,
			timeZone: "Europe/Berlin",
		});

		expect(instants).toEqual({
			startAt: "2026-10-25T00:00:00+02:00",
			stopAt: "2026-10-25T06:00:00+01:00",
		});
		expect(minutesBetween(instants.startAt, instants.stopAt)).toBe(420);
	});

	it("leaves a stop before the start on the same day to the caller", () => {
		const instants = buildStartStopInstants({
			workDate: "2026-11-11",
			startTime: "10:00",
			stopTime: "09:00",
			stopsNextDay: false,
			timeZone: "Europe/Berlin",
		});

		expect(minutesBetween(instants.startAt, instants.stopAt)).toBeNull();
	});
});

describe("reading instants back", () => {
	it("shows a stored instant on the wall clock of the entry's zone", () => {
		expect(
			wallClockInZone("2026-11-12T00:30:00.000Z", "Europe/Berlin"),
		).toEqual({ date: "2026-11-12", time: "01:30" });
		expect(
			wallClockInZone("2026-11-12T00:30:00.000Z", "America/New_York"),
		).toEqual({ date: "2026-11-11", time: "19:30" });
	});

	it("names today in the given zone, not the machine's", () => {
		const now = new Date("2026-11-11T23:30:00.000Z");

		expect(todayInZone("Europe/Berlin", now)).toBe("2026-11-12");
		expect(todayInZone("America/New_York", now)).toBe("2026-11-11");
	});
});

describe("isTimeOfDay", () => {
	it.each([
		["09:05", true],
		["23:59", true],
		["24:00", false],
		["9:05", false],
		["", false],
	])("%s → %s", (value, expected) => {
		expect(isTimeOfDay(value)).toBe(expected);
	});
});

describe("newEntryTimeZone", () => {
	it("starts a new entry in the profile time zone", () => {
		expect(newEntryTimeZone("America/New_York", "Europe/Berlin")).toBe(
			"America/New_York",
		);
	});

	it.each([
		["none is set", null],
		["the projects have not loaded", undefined],
	])("falls back to the browser's zone when %s", (_label, profile) => {
		expect(newEntryTimeZone(profile, "Europe/Berlin")).toBe(
			"Europe/Berlin",
		);
	});
});
