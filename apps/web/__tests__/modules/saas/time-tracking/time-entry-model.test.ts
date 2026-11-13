/**
 * How the My time page shapes the caller's entries: the week table, the day
 * groups, and the project and activity a new entry starts from.
 */

import {
	buildWeekTable,
	groupDayEntries,
	minutesByDate,
	newEntryDefaults,
	type TimeEntry,
	weekDates,
} from "@saas/time-tracking/lib/time-entry-model";
import { describe, expect, it } from "vitest";

let sequence = 0;

function entry(overrides: Partial<TimeEntry>): TimeEntry {
	sequence += 1;
	return {
		id: `entry-${sequence}`,
		projectId: "project-a",
		projectName: "Alpha",
		workDate: "2026-11-09",
		timezone: "Europe/Berlin",
		durationMinutes: 60,
		startAt: null,
		stopAt: null,
		activity: "DEVELOPMENT",
		billable: true,
		description: null,
		storyId: null,
		storyIdentifier: null,
		storyTitle: null,
		startStopRequired: false,
		createdAt: `2026-11-09T08:00:${String(sequence).padStart(2, "0")}.000Z`,
		updatedAt: "2026-11-09T08:00:00.000Z",
		...overrides,
	};
}

describe("weekDates", () => {
	it("lists Monday to Sunday", () => {
		expect(weekDates("2026-11-09")).toEqual([
			"2026-11-09",
			"2026-11-10",
			"2026-11-11",
			"2026-11-12",
			"2026-11-13",
			"2026-11-14",
			"2026-11-15",
		]);
	});
});

describe("buildWeekTable", () => {
	it("makes one row per project with time, sorted by name, with totals", () => {
		const table = buildWeekTable(
			[
				entry({
					projectId: "b",
					projectName: "Beta",
					durationMinutes: 30,
				}),
				entry({
					projectId: "a",
					projectName: "Alpha",
					durationMinutes: 90,
				}),
				entry({
					projectId: "a",
					projectName: "Alpha",
					workDate: "2026-11-11",
					durationMinutes: 45,
				}),
				entry({
					projectId: "b",
					projectName: "Beta",
					workDate: "2026-11-15",
					durationMinutes: 15,
				}),
			],
			"2026-11-09",
		);

		expect(table.rows.map((row) => row.projectName)).toEqual([
			"Alpha",
			"Beta",
		]);
		expect(table.rows[0].cells).toEqual([90, 0, 45, 0, 0, 0, 0]);
		expect(table.rows[0].totalMinutes).toBe(135);
		expect(table.rows[1].cells).toEqual([30, 0, 0, 0, 0, 0, 15]);
		expect(table.dayTotals).toEqual([120, 0, 45, 0, 0, 0, 15]);
		expect(table.totalMinutes).toBe(180);
	});

	it("ignores entries outside the week", () => {
		const table = buildWeekTable(
			[
				entry({ workDate: "2026-11-08" }),
				entry({ workDate: "2026-11-16" }),
			],
			"2026-11-09",
		);

		expect(table.rows).toEqual([]);
		expect(table.totalMinutes).toBe(0);
	});

	it("has no rows for an empty week", () => {
		expect(buildWeekTable([], "2026-11-09").rows).toEqual([]);
	});
});

describe("minutesByDate", () => {
	it("totals each date and keeps empty dates at zero", () => {
		expect(
			minutesByDate(
				[
					entry({ workDate: "2026-11-09", durationMinutes: 30 }),
					entry({ workDate: "2026-11-09", durationMinutes: 45 }),
				],
				["2026-11-09", "2026-11-10"],
			),
		).toEqual({ "2026-11-09": 75, "2026-11-10": 0 });
	});
});

describe("groupDayEntries", () => {
	it("groups one day's entries by project in the order they were logged", () => {
		const first = entry({ projectId: "b", projectName: "Beta" });
		const second = entry({ projectId: "a", projectName: "Alpha" });
		const third = entry({
			projectId: "b",
			projectName: "Beta",
			durationMinutes: 30,
		});
		const otherDay = entry({ workDate: "2026-11-10" });

		const groups = groupDayEntries(
			[third, otherDay, second, first],
			"2026-11-09",
		);

		expect(groups.map((group) => group.projectName)).toEqual([
			"Alpha",
			"Beta",
		]);
		expect(groups[1].entries.map((item) => item.id)).toEqual([
			first.id,
			third.id,
		]);
		expect(groups[1].totalMinutes).toBe(90);
	});
});

describe("newEntryDefaults", () => {
	const projects = [{ id: "a" }, { id: "b" }];

	it("starts from the most recently logged entry", () => {
		const defaults = newEntryDefaults(
			[
				entry({
					projectId: "a",
					activity: "TESTING",
					createdAt: "2026-11-09T08:00:00.000Z",
				}),
				entry({
					projectId: "b",
					activity: "CODE_REVIEW",
					createdAt: "2026-11-10T08:00:00.000Z",
				}),
			],
			projects,
		);

		expect(defaults).toEqual({ projectId: "b", activity: "CODE_REVIEW" });
	});

	it("skips an entry on a project the caller can no longer log to", () => {
		const defaults = newEntryDefaults(
			[
				entry({
					projectId: "a",
					activity: "TESTING",
					createdAt: "2026-11-09T08:00:00.000Z",
				}),
				entry({
					projectId: "gone",
					activity: "CODE_REVIEW",
					createdAt: "2026-11-10T08:00:00.000Z",
				}),
			],
			projects,
		);

		expect(defaults).toEqual({ projectId: "a", activity: "TESTING" });
	});

	it("falls back to the first loggable project and Development", () => {
		expect(newEntryDefaults([], projects)).toEqual({
			projectId: "a",
			activity: "DEVELOPMENT",
		});
	});

	it("has no project when nothing is loggable", () => {
		expect(newEntryDefaults([], [])).toEqual({
			projectId: null,
			activity: "DEVELOPMENT",
		});
	});
});
