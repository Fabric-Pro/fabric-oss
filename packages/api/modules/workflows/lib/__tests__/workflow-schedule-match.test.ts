import type { ScheduleSpecDescription } from "@temporalio/client";
import { expect, it } from "vitest";
import { workflowScheduleMatches } from "../workflow-schedule-match";

const range = <T extends string | number>(start: T, end = start) => [
	{ start, end, step: 1 },
];
const spec: ScheduleSpecDescription = {
	calendars: [
		{
			second: range(0),
			minute: range(0),
			hour: range(9),
			dayOfMonth: range(1, 31),
			month: range("JANUARY" as const, "DECEMBER" as const),
			year: [],
			dayOfWeek: range("MONDAY" as const),
		},
	],
	timezone: "Europe/Berlin",
	intervals: [],
	skip: [],
	jitter: 30_000,
};
const wanted = { cron: "0 9 * * 1", timezone: "Europe/Berlin" };
it("compares Temporal's normalized calendar with the published cadence", () => {
	expect(workflowScheduleMatches(spec, wanted)).toBe(true);
	expect(
		workflowScheduleMatches(spec, { ...wanted, cron: "0 10 * * 1" }),
	).toBe(false);
	expect(workflowScheduleMatches(spec, { ...wanted, timezone: "UTC" })).toBe(
		false,
	);
});
it("refuses to call a paused-time window or additional interval synchronized", () => {
	expect(
		workflowScheduleMatches(
			{ ...spec, startAt: new Date("2030-01-01") },
			wanted,
		),
	).toBe(false);
	expect(
		workflowScheduleMatches(
			{ ...spec, intervals: [{ every: 60_000, offset: 0 }] },
			wanted,
		),
	).toBe(false);
});
it("reports unsupported calendar semantics as unverified rather than healthy", () => {
	expect(
		workflowScheduleMatches(spec, { ...wanted, cron: "0 9 L * *" }),
	).toBe(null);
});
it("treats Temporal's final sixth field as year, not seconds", () => {
	const calendar = spec.calendars?.[0];
	if (!calendar) {
		throw new Error("Missing calendar fixture");
	}
	expect(
		workflowScheduleMatches(
			{ ...spec, calendars: [{ ...calendar, year: range(2030) }] },
			{ ...wanted, cron: "0 9 * * 1 2030" },
		),
	).toBe(true);
	expect(
		workflowScheduleMatches(spec, { ...wanted, cron: "0 9 * * 1 2030" }),
	).toBe(false);
});
