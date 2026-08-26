/**
 * Unit tests for the Atlas atlas-tab helpers.
 *
 * `formatDuration` drives the analysis-history run rows: the largest fitting
 * unit wins (so a long run reads "1h 5m", not a giant seconds count) and
 * rounding carries cleanly between units (never "1m 60s" / "1h 60m").
 */
import { describe, expect, it } from "vitest";
import {
	bucketByRecency,
	formatDuration,
	formatTokens,
	formatUsdFromMicros,
	recencyBucketOf,
} from "../atlas-utils";

describe("formatDuration", () => {
	it("returns an empty string for null / NaN / negative input", () => {
		expect(formatDuration(null)).toBe("");
		expect(formatDuration(Number.NaN)).toBe("");
		expect(formatDuration(-5)).toBe("");
	});

	it("shows one decimal below 10 seconds", () => {
		expect(formatDuration(500)).toBe("0.5s");
		expect(formatDuration(8300)).toBe("8.3s");
		expect(formatDuration(9000)).toBe("9.0s");
	});

	it("shows whole seconds from 10s up to a minute", () => {
		expect(formatDuration(10_000)).toBe("10s");
		expect(formatDuration(42_400)).toBe("42s");
	});

	it("shows minutes and seconds from 1 minute up to an hour", () => {
		expect(formatDuration(60_000)).toBe("1m 0s");
		// The example from the spec: "83.2s" now reads "1m 23s".
		expect(formatDuration(83_200)).toBe("1m 23s");
		expect(formatDuration(90_000)).toBe("1m 30s");
	});

	it("shows hours and minutes from 1 hour up", () => {
		expect(formatDuration(3_600_000)).toBe("1h 0m");
		expect(formatDuration(3_900_000)).toBe("1h 5m");
		expect(formatDuration(7_380_000)).toBe("2h 3m");
	});

	it("carries rounding cleanly between units (no 60s / 60m)", () => {
		// 1m 59.6s rounds up to 2m 0s, never "1m 60s".
		expect(formatDuration(119_600)).toBe("2m 0s");
		// 1h 59m 40s rounds up to 2h 0m, never "1h 60m".
		expect(formatDuration(7_180_000)).toBe("2h 0m");
	});
});

describe("formatTokens", () => {
	it("returns an empty string for null / NaN / negative input", () => {
		expect(formatTokens(null)).toBe("");
		expect(formatTokens(Number.NaN)).toBe("");
		expect(formatTokens(-1)).toBe("");
	});

	it("shows the integer below 1,000", () => {
		expect(formatTokens(0)).toBe("0");
		expect(formatTokens(42)).toBe("42");
		expect(formatTokens(999)).toBe("999");
	});

	it("shows a compact thousands form with a trimmed trailing zero", () => {
		expect(formatTokens(1000)).toBe("1k");
		expect(formatTokens(12_500)).toBe("12.5k");
		expect(formatTokens(999_000)).toBe("999k");
	});

	it("shows a compact millions form", () => {
		expect(formatTokens(1_000_000)).toBe("1M");
		expect(formatTokens(1_200_000)).toBe("1.2M");
	});
});

describe("formatUsdFromMicros", () => {
	it("returns an empty string for null / NaN / negative input", () => {
		expect(formatUsdFromMicros(null)).toBe("");
		expect(formatUsdFromMicros(Number.NaN)).toBe("");
		expect(formatUsdFromMicros(-1)).toBe("");
	});

	it("renders exactly $0 for a zero cost", () => {
		expect(formatUsdFromMicros(0)).toBe("$0");
	});

	it("shows four decimals below $1 so sub-cent runs stay legible", () => {
		// 2,300 micro-USD = $0.0023.
		expect(formatUsdFromMicros(2300)).toBe("$0.0023");
		expect(formatUsdFromMicros(100)).toBe("$0.0001");
	});

	it("floors a sub-$0.0001 cost so a real tiny cost is never shown as free", () => {
		// 1 micro-USD = $0.000001 would round to $0.0000.
		expect(formatUsdFromMicros(1)).toBe("<$0.0001");
	});

	it("shows two decimals at or above $1", () => {
		// 1,230,000 micro-USD = $1.23.
		expect(formatUsdFromMicros(1_230_000)).toBe("$1.23");
		expect(formatUsdFromMicros(12_000_000)).toBe("$12.00");
	});
});

// A fixed "now" at local noon keeps the day boundaries deterministic and away
// from midnight / DST edges regardless of the runner's timezone.
const NOON = new Date("2026-06-08T12:00:00").getTime();
const HOUR = 3_600_000;
const DAY = 86_400_000;
const isoAgo = (ms: number) => new Date(NOON - ms).toISOString();

describe("recencyBucketOf", () => {
	it("classifies today, yesterday, this week, and older", () => {
		expect(recencyBucketOf(isoAgo(HOUR), NOON)).toBe("today");
		// 13h before noon lands at ~23:00 the previous day.
		expect(recencyBucketOf(isoAgo(13 * HOUR), NOON)).toBe("yesterday");
		// 2–6 days ago is the rest of the trailing week.
		expect(recencyBucketOf(isoAgo(3 * DAY), NOON)).toBe("thisWeek");
		expect(recencyBucketOf(isoAgo(6 * DAY), NOON)).toBe("thisWeek");
		expect(recencyBucketOf(isoAgo(10 * DAY), NOON)).toBe("older");
	});

	it("treats an unparseable timestamp as older", () => {
		expect(recencyBucketOf("not-a-date", NOON)).toBe("older");
	});
});

describe("bucketByRecency", () => {
	it("groups items into the four buckets, preserving input order", () => {
		const items = [
			{ id: "a", ts: isoAgo(HOUR) }, // today
			{ id: "b", ts: isoAgo(30 * HOUR) }, // yesterday
			{ id: "c", ts: isoAgo(4 * DAY) }, // this week
			{ id: "d", ts: isoAgo(20 * DAY) }, // older
			{ id: "e", ts: isoAgo(2 * HOUR) }, // today (after a)
		];
		const buckets = bucketByRecency(items, (item) => item.ts, NOON);
		expect(buckets.today.map((i) => i.id)).toEqual(["a", "e"]);
		expect(buckets.yesterday.map((i) => i.id)).toEqual(["b"]);
		expect(buckets.thisWeek.map((i) => i.id)).toEqual(["c"]);
		expect(buckets.older.map((i) => i.id)).toEqual(["d"]);
	});
});
