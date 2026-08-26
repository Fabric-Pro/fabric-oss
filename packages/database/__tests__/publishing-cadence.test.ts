import { describe, expect, it } from "vitest";
import {
	cadenceIntervalDays,
	isPublishingCycleDue,
} from "../src/publishing-cadence";

const NOW = new Date("2026-08-11T06:00:00.000Z");

describe("cadenceIntervalDays", () => {
	it("maps every known cadence, and MANUAL to null", () => {
		expect(cadenceIntervalDays("MANUAL")).toBeNull();
		expect(cadenceIntervalDays("WEEKLY")).toBe(7);
		expect(cadenceIntervalDays("BIWEEKLY")).toBe(14);
		expect(cadenceIntervalDays("MONTHLY")).toBe(30);
	});

	it("falls back to weekly for an unrecognised stored value", () => {
		// A corrupt settings row must not be able to wedge the sweep.
		expect(cadenceIntervalDays("FORTNIGHTLY-ISH")).toBe(7);
	});
});

describe("isPublishingCycleDue", () => {
	it("is due when the project has never run", () => {
		expect(isPublishingCycleDue({ cadence: "WEEKLY" }, null, NOW)).toBe(
			true,
		);
	});

	it("is never due on MANUAL, even with no prior run", () => {
		expect(isPublishingCycleDue({ cadence: "MANUAL" }, null, NOW)).toBe(
			false,
		);
	});

	it("is due exactly on the interval boundary despite sub-day clock skew", () => {
		// The drift case. A run at 06:00:00.000 and a tick 7 days later that
		// fires a few ms EARLY is still the 7th day — comparing elapsed
		// milliseconds would read 6d23h59m, defer a day, and drift later every
		// period. Whole-UTC-date comparison must not.
		const lastRun = new Date("2026-08-04T06:00:00.000Z");
		const tickSlightlyEarly = new Date("2026-08-11T05:59:59.900Z");
		expect(
			isPublishingCycleDue(
				{ cadence: "WEEKLY" },
				lastRun,
				tickSlightlyEarly,
			),
		).toBe(true);
	});

	it("is not due before the interval has elapsed", () => {
		const lastRun = new Date("2026-08-06T06:00:00.000Z"); // 5 days ago
		expect(isPublishingCycleDue({ cadence: "WEEKLY" }, lastRun, NOW)).toBe(
			false,
		);
	});

	it("honours the longer intervals", () => {
		const tenDaysAgo = new Date("2026-08-01T06:00:00.000Z");
		expect(
			isPublishingCycleDue({ cadence: "BIWEEKLY" }, tenDaysAgo, NOW),
		).toBe(false);
		const twentyDaysAgo = new Date("2026-07-22T06:00:00.000Z");
		expect(
			isPublishingCycleDue({ cadence: "BIWEEKLY" }, twentyDaysAgo, NOW),
		).toBe(true);
		expect(
			isPublishingCycleDue({ cadence: "MONTHLY" }, twentyDaysAgo, NOW),
		).toBe(false);
	});

	it("fires up to nearly a day early when lastStartedAt is not aligned to the tick hour — the documented trade-off, not a bug", () => {
		// Pins the bounded early-trigger property described in the module doc
		// comment: whole-UTC-date comparison counts date boundaries crossed,
		// not elapsed hours. A run at 23:00 UTC and a tick at 01:00 UTC seven
		// calendar days later cross 7 date boundaries but only 146 of the 168
		// hours a week actually contains. If this predicate is ever "fixed" to
		// compare elapsed milliseconds instead, this assertion flips to false
		// — that would reintroduce the drift-until-skip failure the doc
		// comment explains whole-date comparison was chosen to avoid.
		const lastRun = new Date("2026-08-04T23:00:00.000Z");
		const tick = new Date("2026-08-11T01:00:00.000Z");
		expect(isPublishingCycleDue({ cadence: "WEEKLY" }, lastRun, tick)).toBe(
			true,
		);
	});

	it("is not due when lastStartedAt is in the future relative to now", () => {
		// Clock skew, or a manual run that just happened moments ago. The
		// interval math must degrade safely to "not due" rather than a
		// negative day-count surprising its caller into treating the project
		// as due.
		const future = new Date("2026-08-12T06:00:00.000Z");
		expect(isPublishingCycleDue({ cadence: "WEEKLY" }, future, NOW)).toBe(
			false,
		);
	});
});
