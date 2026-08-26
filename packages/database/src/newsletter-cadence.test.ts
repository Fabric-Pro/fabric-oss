import { describe, expect, it } from "vitest";
import {
	cadenceDefaultLookbackDays,
	isNewsletterDue,
	manualDedupeKey,
	periodBucket,
	resolveWindow,
	scheduledDedupeKey,
} from "./newsletter-cadence";

const baseSettings = {
	cadence: "WEEKLY" as const,
	dayOfWeek: 1, // Monday
	dayOfMonth: 1,
	sendHourUtc: 9,
	lastSentAt: null as Date | null,
};

describe("isNewsletterDue", () => {
	it("weekly: due on the configured weekday+hour when never sent", () => {
		// 2026-06-15 is a Monday; 09:00 UTC
		const now = new Date("2026-06-15T09:30:00.000Z");
		expect(isNewsletterDue(baseSettings, now)).toBe(true);
	});

	it("weekly: not due on a different weekday", () => {
		const now = new Date("2026-06-16T09:30:00.000Z"); // Tuesday
		expect(isNewsletterDue(baseSettings, now)).toBe(false);
	});

	it("weekly: not due at a different hour", () => {
		const now = new Date("2026-06-15T08:30:00.000Z");
		expect(isNewsletterDue(baseSettings, now)).toBe(false);
	});

	it("weekly: not due twice in the same day (lastSentAt guard)", () => {
		const now = new Date("2026-06-15T09:30:00.000Z");
		const s = {
			...baseSettings,
			lastSentAt: new Date("2026-06-15T09:05:00.000Z"),
		};
		expect(isNewsletterDue(s, now)).toBe(false);
	});

	it("monthly: due on configured dayOfMonth+hour", () => {
		const now = new Date("2026-07-01T09:10:00.000Z");
		const s = {
			...baseSettings,
			cadence: "MONTHLY" as const,
			dayOfMonth: 1,
		};
		expect(isNewsletterDue(s, now)).toBe(true);
	});
});

describe("periodBucket + dedupeKey", () => {
	it("weekly bucket is the ISO week", () => {
		expect(periodBucket("WEEKLY", new Date("2026-06-15T09:00:00Z"))).toBe(
			"2026-W25",
		);
	});
	it("monthly bucket is YYYY-MM", () => {
		expect(periodBucket("MONTHLY", new Date("2026-07-01T09:00:00Z"))).toBe(
			"2026-07",
		);
	});
	it("scheduled key includes project + bucket", () => {
		expect(
			scheduledDedupeKey(
				"p1",
				"WEEKLY",
				new Date("2026-06-15T09:00:00Z"),
			),
		).toBe("scheduled:p1:2026-W25");
	});
	it("manual key floors window end to the minute", () => {
		expect(
			manualDedupeKey("p1", new Date("2026-06-15T09:30:45.123Z")),
		).toBe("manual:p1:2026-06-15T09:30:00.000Z");
	});
});

describe("cadenceDefaultLookbackDays", () => {
	it("is 7 for weekly and 30 for monthly", () => {
		expect(cadenceDefaultLookbackDays("WEEKLY")).toBe(7);
		expect(cadenceDefaultLookbackDays("MONTHLY")).toBe(30);
	});
});

describe("resolveWindow", () => {
	const now = new Date("2026-06-15T09:00:00Z");

	it("null lookback, never sent: start = now - fallbackDays (caller fallback)", () => {
		const w7 = resolveWindow(
			{ lookbackDays: null, lastSentAt: null },
			now,
			7,
		);
		expect(w7.start.toISOString()).toBe("2026-06-08T09:00:00.000Z");
		expect(w7.end.toISOString()).toBe(now.toISOString());
		const w30 = resolveWindow(
			{ lookbackDays: null, lastSentAt: null },
			now,
			30,
		);
		expect(w30.start.toISOString()).toBe("2026-05-16T09:00:00.000Z");
	});

	it("null lookback, sent: start = lastSentAt (incremental, no overlap)", () => {
		const last = new Date("2026-06-08T09:00:00Z");
		const w = resolveWindow(
			{ lookbackDays: null, lastSentAt: last },
			now,
			7,
		);
		expect(w.start.toISOString()).toBe(last.toISOString());
	});

	it("null monthly across a 28-day Feb interval: start = lastSentAt, no duplicate", () => {
		const marchNow = new Date("2026-03-01T09:00:00Z");
		const feb = new Date("2026-02-01T09:00:00Z"); // 28 days earlier
		const w = resolveWindow(
			{ lookbackDays: null, lastSentAt: feb },
			marchNow,
			30,
		);
		// fixed 30d back would be 2026-01-30 (overlap); incremental must use lastSentAt.
		expect(w.start.toISOString()).toBe(feb.toISOString());
	});

	it("explicit N, never sent: start = now - N", () => {
		const w = resolveWindow({ lookbackDays: 90, lastSentAt: null }, now, 7);
		expect(w.start.toISOString()).toBe(
			new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000).toISOString(),
		);
	});

	it("explicit N, lastSentAt OLDER than N: start = lastSentAt (catch-up)", () => {
		const last = new Date("2026-05-01T09:00:00Z"); // ~45d ago, older than now-7d -> catch-up
		const w = resolveWindow({ lookbackDays: 7, lastSentAt: last }, now, 7);
		expect(w.start.toISOString()).toBe(last.toISOString());
	});

	it("explicit N, lastSentAt NEWER than N: start = now - N (minimum honored)", () => {
		const last = new Date("2026-06-13T09:00:00Z"); // 2 days ago, newer than now-7
		const w = resolveWindow({ lookbackDays: 7, lastSentAt: last }, now, 7);
		expect(w.start.toISOString()).toBe("2026-06-08T09:00:00.000Z");
	});
});
