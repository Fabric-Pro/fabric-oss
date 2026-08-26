import { afterEach, describe, expect, it, vi } from "vitest";
import { formatAbsoluteTime, formatDuration, timeAgo } from "../pipeline-run";

const NOW = new Date("2026-07-26T12:00:00Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

afterEach(() => {
	vi.useRealTimers();
});

function atNow() {
	vi.useFakeTimers();
	vi.setSystemTime(NOW);
}

describe("timeAgo", () => {
	it("returns null for a missing or unparseable value", () => {
		expect(timeAgo(null)).toBeNull();
		expect(timeAgo(undefined)).toBeNull();
		expect(timeAgo("not a date")).toBeNull();
	});

	it("reports the usual buckets", () => {
		atNow();
		// Rounded to the nearest minute, so 30s already reads as 1m.
		expect(timeAgo(ago(10_000))).toBe("just now");
		expect(timeAgo(ago(30_000))).toBe("1m ago");
		expect(timeAgo(ago(5 * MIN))).toBe("5m ago");
		expect(timeAgo(ago(3 * HOUR))).toBe("3h ago");
		expect(timeAgo(ago(12 * DAY))).toBe("12d ago");
	});

	it("does not report a FUTURE run as having just happened", () => {
		// CI runner clock skew produces a negative delta, which used to fall
		// through the `< 1 minute` branch and read as "just now" for a run
		// timestamped tomorrow.
		atNow();
		const tomorrow = new Date(NOW.getTime() + DAY).toISOString();
		expect(timeAgo(tomorrow)).toBe("just now (clock skew)");
	});

	it("buckets anything past a year instead of counting days forever", () => {
		atNow();
		expect(timeAgo(ago(412 * DAY))).toBe("over a year ago");
		expect(timeAgo(ago(800 * DAY))).toBe("over 2y ago");
	});
});

describe("formatAbsoluteTime", () => {
	it("includes a labelled UTC offset", () => {
		expect(formatAbsoluteTime("2026-07-27T10:00:00Z")).toMatch(
			/GMT[+-]\d+/,
		);
	});

	it("returns null for missing or invalid values", () => {
		expect(formatAbsoluteTime(null)).toBeNull();
		expect(formatAbsoluteTime("not a date")).toBeNull();
	});
});

describe("formatDuration", () => {
	it("returns null when the provider reported none", () => {
		expect(formatDuration(null)).toBeNull();
		expect(formatDuration(undefined)).toBeNull();
	});

	it("formats minutes and seconds", () => {
		expect(formatDuration(192_000)).toBe("3m 12s");
		expect(formatDuration(27_000)).toBe("27s");
	});
});
