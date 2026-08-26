import { describe, expect, it } from "vitest";
import {
	computeNextRunAt,
	normalizeReportSchedule,
	parseStoredReportSchedule,
	type ReportScheduleConfig,
} from "../report-schedule";

const iso = (d: Date) => d.toISOString();
const NY = "America/New_York";

// Build a normalized config directly for computeNextRunAt tests.
function cfg(
	p: Partial<ReportScheduleConfig> &
		Pick<ReportScheduleConfig, "frequency" | "anchorAt">,
): ReportScheduleConfig {
	return {
		hour: 9,
		minute: 0,
		timezone: "UTC",
		...p,
	} as ReportScheduleConfig;
}

describe("normalizeReportSchedule", () => {
	it("applies hour/minute/timezone defaults and freezes anchorAt as the first future occurrence (daily, UTC)", () => {
		const from = new Date("2026-06-23T20:00:00Z");
		const n = normalizeReportSchedule({ frequency: "daily" }, from);
		expect(n).not.toBeNull();
		expect(n?.hour).toBe(9);
		expect(n?.minute).toBe(0);
		expect(n?.timezone).toBe("UTC");
		// next 09:00 UTC after 20:00 is tomorrow 09:00
		expect(n?.anchorAt).toBe("2026-06-24T09:00:00.000Z");
	});

	it("resolves omitted dayOfWeek for weekly to the weekday of the first occurrence and freezes it", () => {
		// from = Tue 2026-06-23 06:00 UTC; next 09:00 today (Tue) is still future → anchor Tue
		const from = new Date("2026-06-23T06:00:00Z");
		const n = normalizeReportSchedule({ frequency: "weekly" }, from);
		expect(n?.dayOfWeek).toBe(2); // Tuesday (0=Sun)
		expect(n?.anchorAt).toBe("2026-06-23T09:00:00.000Z");
	});

	it("REGRESSION (Codex P1): an EXPLICIT weekly dayOfWeek freezes the anchor on THAT weekday, not the creation day", () => {
		// created Tue 2026-06-23; explicit Friday(5) → first occurrence Fri 2026-06-26
		const from = new Date("2026-06-23T06:00:00Z");
		const n = normalizeReportSchedule(
			{ frequency: "weekly", dayOfWeek: 5 },
			from,
		);
		expect(n?.dayOfWeek).toBe(5);
		expect(n?.anchorAt).toBe("2026-06-26T09:00:00.000Z");
	});

	it("REGRESSION (Codex P1): explicit biweekly dayOfWeek anchors on that weekday and strides 14 days from it", () => {
		const from = new Date("2026-06-23T06:00:00Z"); // Tue
		const n = normalizeReportSchedule(
			{ frequency: "biweekly", dayOfWeek: 5 },
			from,
		);
		expect(n?.anchorAt).toBe("2026-06-26T09:00:00.000Z"); // first Friday
		// advancing just after the first occurrence → +14 days (Fri 2026-07-10)
		expect(
			iso(
				computeNextRunAt(
					n as ReportScheduleConfig,
					new Date("2026-06-26T09:00:05.000Z"),
				),
			),
		).toBe("2026-07-10T09:00:00.000Z");
	});

	it("resolves omitted dayOfMonth for monthly to the day of the first occurrence", () => {
		const from = new Date("2026-06-10T06:00:00Z");
		const n = normalizeReportSchedule({ frequency: "monthly" }, from);
		expect(n?.dayOfMonth).toBe(10);
		expect(n?.anchorAt).toBe("2026-06-10T09:00:00.000Z");
	});

	it("returns null for malformed/unknown input", () => {
		expect(
			normalizeReportSchedule(
				{ frequency: "yearly" },
				new Date("2026-06-23T00:00:00Z"),
			),
		).toBeNull();
		expect(
			normalizeReportSchedule(null, new Date("2026-06-23T00:00:00Z")),
		).toBeNull();
		expect(
			normalizeReportSchedule({}, new Date("2026-06-23T00:00:00Z")),
		).toBeNull();
	});

	it("REGRESSION (Copilot): rejects an invalid IANA timezone instead of letting TZDate throw at runtime", () => {
		expect(
			normalizeReportSchedule(
				{ frequency: "daily", timezone: "Not/AZone" },
				new Date("2026-06-23T00:00:00Z"),
			),
		).toBeNull();
	});

	it("accepts a valid non-UTC IANA timezone", () => {
		const n = normalizeReportSchedule(
			{ frequency: "daily", timezone: NY },
			new Date("2026-06-23T00:00:00Z"),
		);
		expect(n?.timezone).toBe(NY);
	});
});

describe("parseStoredReportSchedule", () => {
	it("accepts a fully-normalized stored config", () => {
		const stored = {
			frequency: "daily",
			hour: 9,
			minute: 0,
			timezone: "UTC",
			anchorAt: "2026-06-24T09:00:00.000Z",
		};
		expect(parseStoredReportSchedule(stored)).toMatchObject({
			frequency: "daily",
			anchorAt: stored.anchorAt,
		});
	});
	it("rejects a config missing anchorAt", () => {
		expect(
			parseStoredReportSchedule({
				frequency: "daily",
				hour: 9,
				minute: 0,
				timezone: "UTC",
			}),
		).toBeNull();
	});

	it("REGRESSION (code-review): rejects weekly/biweekly missing dayOfWeek (would silently drift)", () => {
		const base = {
			hour: 9,
			minute: 0,
			timezone: "UTC",
			anchorAt: "2026-06-29T09:00:00.000Z",
		};
		expect(
			parseStoredReportSchedule({ frequency: "weekly", ...base }),
		).toBeNull();
		expect(
			parseStoredReportSchedule({ frequency: "biweekly", ...base }),
		).toBeNull();
		// present → accepted
		expect(
			parseStoredReportSchedule({
				frequency: "weekly",
				dayOfWeek: 1,
				...base,
			}),
		).not.toBeNull();
	});

	it("REGRESSION (code-review): rejects monthly/quarterly missing dayOfMonth (would throw RangeError)", () => {
		const base = {
			hour: 9,
			minute: 0,
			timezone: "UTC",
			anchorAt: "2026-06-15T09:00:00.000Z",
		};
		expect(
			parseStoredReportSchedule({ frequency: "monthly", ...base }),
		).toBeNull();
		expect(
			parseStoredReportSchedule({ frequency: "quarterly", ...base }),
		).toBeNull();
		expect(
			parseStoredReportSchedule({
				frequency: "monthly",
				dayOfMonth: 15,
				...base,
			}),
		).not.toBeNull();
	});

	it("REGRESSION (Copilot): rejects a stored config with an invalid timezone", () => {
		expect(
			parseStoredReportSchedule({
				frequency: "daily",
				hour: 9,
				minute: 0,
				timezone: "Mars/Phobos",
				anchorAt: "2026-06-24T09:00:00.000Z",
			}),
		).toBeNull();
	});
});

describe("computeNextRunAt — strictly after & phase stability", () => {
	it("daily returns the next hh:mm strictly after from", () => {
		const s = cfg({
			frequency: "daily",
			anchorAt: "2026-06-24T09:00:00.000Z",
		});
		expect(
			iso(computeNextRunAt(s, new Date("2026-06-24T09:00:00.000Z"))),
		).toBe("2026-06-25T09:00:00.000Z"); // strictly after
		expect(
			iso(computeNextRunAt(s, new Date("2026-06-24T08:59:59.000Z"))),
		).toBe("2026-06-24T09:00:00.000Z");
	});

	it("weekly advances by exactly 7 days regardless of when computed", () => {
		const s = cfg({
			frequency: "weekly",
			dayOfWeek: 2,
			anchorAt: "2026-06-23T09:00:00.000Z",
		}); // Tue
		expect(
			iso(computeNextRunAt(s, new Date("2026-06-23T09:00:05.000Z"))),
		).toBe("2026-06-30T09:00:00.000Z");
	});

	it("BIWEEKLY is a true 14-day stride (regression: must NOT become 21 days)", () => {
		const s = cfg({
			frequency: "biweekly",
			dayOfWeek: 2,
			anchorAt: "2026-06-23T09:00:00.000Z",
		});
		// computed from a moment seconds after the Jun-23 due instant → +14 days, NOT +21
		expect(
			iso(computeNextRunAt(s, new Date("2026-06-23T09:00:05.000Z"))),
		).toBe("2026-07-07T09:00:00.000Z");
		// a late/catch-up compute long after due still lands on the 14-day grid, next future slot
		expect(
			iso(computeNextRunAt(s, new Date("2026-07-06T12:00:00.000Z"))),
		).toBe("2026-07-07T09:00:00.000Z");
		expect(
			iso(computeNextRunAt(s, new Date("2026-07-08T12:00:00.000Z"))),
		).toBe("2026-07-21T09:00:00.000Z");
	});

	it("weekly weekday does NOT hop when computed on a different calendar day (late dispatch)", () => {
		const s = cfg({
			frequency: "weekly",
			dayOfWeek: 1,
			anchorAt: "2026-06-22T09:00:00.000Z",
		}); // Monday
		// dispatcher fires late on a Tuesday — must still produce the next MONDAY, not Tuesday
		const next = computeNextRunAt(s, new Date("2026-06-23T15:00:00.000Z")); // Tue
		expect(next.getUTCDay()).toBe(1); // Monday
		expect(iso(next)).toBe("2026-06-29T09:00:00.000Z");
	});

	it("monthly clamps dayOfMonth to month end (31 → Feb)", () => {
		const s = cfg({
			frequency: "monthly",
			dayOfMonth: 31,
			anchorAt: "2026-01-31T09:00:00.000Z",
		});
		expect(
			iso(computeNextRunAt(s, new Date("2026-01-31T10:00:00.000Z"))),
		).toBe("2026-02-28T09:00:00.000Z");
	});

	it("quarterly advances by 3 months on the anchored day", () => {
		const s = cfg({
			frequency: "quarterly",
			dayOfMonth: 15,
			anchorAt: "2026-01-15T09:00:00.000Z",
		});
		expect(
			iso(computeNextRunAt(s, new Date("2026-01-15T10:00:00.000Z"))),
		).toBe("2026-04-15T09:00:00.000Z");
	});
});

describe("computeNextRunAt — timezone & DST (America/New_York)", () => {
	it("daily 09:00 NY resolves to the correct UTC instant across the EST→EDT (spring-forward) boundary", () => {
		// Sat 2026-03-07 afternoon; next 09:00 NY is Sun 2026-03-08 (spring-forward) → 09:00 EDT = 13:00 UTC
		const s = cfg({
			frequency: "daily",
			hour: 9,
			minute: 0,
			timezone: NY,
			anchorAt: "2026-03-08T13:00:00.000Z",
		});
		expect(
			iso(computeNextRunAt(s, new Date("2026-03-07T20:00:00.000Z"))),
		).toBe("2026-03-08T13:00:00.000Z");
	});

	it("daily 09:00 NY resolves correctly across the EDT→EST (fall-back) boundary", () => {
		// Sat 2026-10-31; next 09:00 NY is Sun 2026-11-01 (fall-back) → 09:00 EST = 14:00 UTC
		const s = cfg({
			frequency: "daily",
			hour: 9,
			minute: 0,
			timezone: NY,
			anchorAt: "2026-11-01T14:00:00.000Z",
		});
		expect(
			iso(computeNextRunAt(s, new Date("2026-10-31T20:00:00.000Z"))),
		).toBe("2026-11-01T14:00:00.000Z");
	});

	it("a non-existent spring-forward wall-clock time still yields a deterministic, strictly-after instant", () => {
		// 02:30 NY does not exist on 2026-03-08. Assert determinism + strictly-after (default schedules use 09:00).
		const s = cfg({
			frequency: "daily",
			hour: 2,
			minute: 30,
			timezone: NY,
			anchorAt: "2026-03-09T06:30:00.000Z",
		});
		const from = new Date("2026-03-08T06:00:00.000Z");
		const a = computeNextRunAt(s, from);
		const b = computeNextRunAt(s, from);
		expect(a.getTime()).toBe(b.getTime()); // deterministic
		expect(a.getTime()).toBeGreaterThan(from.getTime()); // strictly after
	});
});
