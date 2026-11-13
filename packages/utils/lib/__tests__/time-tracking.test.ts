import { describe, expect, it } from "vitest";
import {
	addDays,
	DAILY_TIME_LIMIT_MINUTES,
	DELETED_USER_NAME,
	detectTimeEntryWarnings,
	type ExistingTimeEntryFacts,
	elapsedMinutes,
	formatDecimalHours,
	formatDurationMinutes,
	inclusiveDaySpan,
	isIsoDate,
	isLikelyDuplicate,
	isValidDurationMinutes,
	isValidTimeZone,
	parseDurationInput,
	resolveEffectiveTimePolicy,
	TIME_ACTIVITIES,
	type TimeEntryFacts,
	timeEntryAuthorName,
	weekRange,
} from "../time-tracking";

describe("parseDurationInput", () => {
	it.each([
		["1h 30m", 90],
		["1h30", 90],
		["1h30m", 90],
		["1H 30M", 90],
		["  2h  ", 120],
		["90m", 90],
		["1.5", 90],
		["1,5", 90],
		[".5", 30],
		["1.5h", 90],
		["1,25h", 75],
		["1:30", 90],
		["0:45", 45],
		["2h", 120],
		// A bare whole number of 12 or less is hours.
		["8", 480],
		["12", 720],
		// Larger bare whole numbers are minutes.
		["13", 13],
		["45", 45],
		["90", 90],
	])("%s → %i minutes", (text, minutes) => {
		expect(parseDurationInput(text)).toBe(minutes);
	});

	it.each([
		"",
		"   ",
		"abc",
		"0",
		"0h",
		"0m",
		"-1h",
		"1h 75m",
		"1:75",
		"1.5h 30m",
		"1h 30m extra",
		"h",
	])("%j is not a duration", (text) => {
		expect(parseDurationInput(text)).toBeNull();
	});
});

describe("formatDecimalHours", () => {
	it.each([
		[90, "1.50"],
		[60, "1.00"],
		[45, "0.75"],
		[25, "0.42"],
		[1, "0.02"],
		[1440, "24.00"],
	])("%i → %s", (minutes, text) => {
		expect(formatDecimalHours(minutes)).toBe(text);
	});
});

describe("formatDurationMinutes", () => {
	it.each([
		[90, "1h 30m"],
		[45, "45m"],
		[120, "2h"],
		[1440, "24h"],
		[61, "1h 1m"],
		[0, "0m"],
	])("%i → %s", (minutes, text) => {
		expect(formatDurationMinutes(minutes)).toBe(text);
	});

	it("round-trips what it formats", () => {
		for (const minutes of [1, 45, 59, 60, 61, 90, 125, 600, 1440]) {
			expect(parseDurationInput(formatDurationMinutes(minutes))).toBe(
				minutes,
			);
		}
	});
});

describe("isValidDurationMinutes", () => {
	it.each([
		[1, true],
		[1440, true],
		[0, false],
		[-5, false],
		[1441, false],
		[1.5, false],
	])("%d → %s", (minutes, valid) => {
		expect(isValidDurationMinutes(minutes)).toBe(valid);
	});
});

describe("TIME_ACTIVITIES", () => {
	it("lists the activities in display order with their labels", () => {
		expect(TIME_ACTIVITIES.map((activity) => activity.label)).toEqual([
			"Planning and requirements",
			"Design / UX",
			"Development",
			"Code review",
			"Testing",
			"Meetings and collaboration",
			"Other",
		]);
	});
});

describe("timeEntryAuthorName", () => {
	it("prefers the author's current name", () => {
		expect(
			timeEntryAuthorName({
				currentName: "Ada Renamed",
				savedName: "Ada",
			}),
		).toBe("Ada Renamed");
	});

	it("falls back to the saved name once the account is deleted", () => {
		expect(
			timeEntryAuthorName({ currentName: null, savedName: "Ada" }),
		).toBe("Ada");
	});

	it("reads a deleted account with no saved name as a deleted user", () => {
		expect(
			timeEntryAuthorName({ currentName: null, savedName: null }),
		).toBe(DELETED_USER_NAME);
		expect(DELETED_USER_NAME).toBe("Deleted user");
	});
});

describe("resolveEffectiveTimePolicy", () => {
	const unset = { timeRequireStartStop: false, timeDefaultBillable: null };

	it("defaults to duration-only and billable", () => {
		expect(
			resolveEffectiveTimePolicy({ org: unset, project: unset }),
		).toEqual({ startStopRequired: false, defaultBillable: true });
	});

	it("applies the organization's start/stop requirement to every project", () => {
		expect(
			resolveEffectiveTimePolicy({
				org: { ...unset, timeRequireStartStop: true },
				project: unset,
			}).startStopRequired,
		).toBe(true);
	});

	it("lets a project require start/stop on its own", () => {
		expect(
			resolveEffectiveTimePolicy({
				org: unset,
				project: { ...unset, timeRequireStartStop: true },
			}).startStopRequired,
		).toBe(true);
	});

	it("does not let a project lift the organization's requirement", () => {
		expect(
			resolveEffectiveTimePolicy({
				org: { ...unset, timeRequireStartStop: true },
				project: { ...unset, timeRequireStartStop: false },
			}).startStopRequired,
		).toBe(true);
	});

	it.each([
		[null, null, true],
		[false, null, false],
		[true, null, true],
		[null, false, false],
		[true, false, false],
		[false, true, true],
	])(
		"organization default %s, project default %s → billable %s",
		(orgDefault, projectDefault, billable) => {
			expect(
				resolveEffectiveTimePolicy({
					org: { ...unset, timeDefaultBillable: orgDefault },
					project: { ...unset, timeDefaultBillable: projectDefault },
				}).defaultBillable,
			).toBe(billable);
		},
	);
});

describe("elapsedMinutes", () => {
	it("counts real elapsed time across the autumn daylight-saving change", () => {
		// 01:30 summer time to 03:30 winter time in Central Europe: the clock
		// reads two hours apart, three hours passed.
		expect(
			elapsedMinutes(
				new Date("2026-10-25T01:30:00+02:00"),
				new Date("2026-10-25T03:30:00+01:00"),
			),
		).toBe(180);
	});

	it("counts real elapsed time across the spring daylight-saving change", () => {
		expect(
			elapsedMinutes(
				new Date("2026-03-29T01:30:00+01:00"),
				new Date("2026-03-29T03:30:00+02:00"),
			),
		).toBe(60);
	});

	it("counts an entry that runs past midnight", () => {
		expect(
			elapsedMinutes(
				new Date("2026-11-10T22:00:00+01:00"),
				new Date("2026-11-11T01:15:00+01:00"),
			),
		).toBe(195);
	});

	it("rounds to the nearest minute", () => {
		expect(
			elapsedMinutes(
				new Date("2026-11-10T09:00:00Z"),
				new Date("2026-11-10T09:10:40Z"),
			),
		).toBe(11);
	});

	it.each([
		["2026-11-10T09:00:00Z", "2026-11-10T09:00:00Z"],
		["2026-11-10T10:00:00Z", "2026-11-10T09:00:00Z"],
	])("refuses stop %s not after start", (start, stop) => {
		expect(elapsedMinutes(new Date(start), new Date(stop))).toBeNull();
	});
});

describe("isValidTimeZone", () => {
	it.each(["UTC", "Europe/Berlin", "America/Argentina/Buenos_Aires"])(
		"accepts %s",
		(zone) => {
			expect(isValidTimeZone(zone)).toBe(true);
		},
	);

	it.each(["", "Not/AZone", "+02:00", "Europe/Berlin; drop", "local"])(
		"refuses %j",
		(zone) => {
			expect(isValidTimeZone(zone)).toBe(false);
		},
	);
});

describe("work dates", () => {
	it.each([
		["2026-11-11", { from: "2026-11-09", to: "2026-11-15" }],
		["2026-11-09", { from: "2026-11-09", to: "2026-11-15" }],
		["2026-11-15", { from: "2026-11-09", to: "2026-11-15" }],
		["2026-01-01", { from: "2025-12-29", to: "2026-01-04" }],
		["2024-02-29", { from: "2024-02-26", to: "2024-03-03" }],
	])("the week of %s runs Monday to Sunday", (date, range) => {
		expect(weekRange(date)).toEqual(range);
	});

	it("adds days across a month end", () => {
		expect(addDays("2026-01-30", 3)).toBe("2026-02-02");
		expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
	});

	it("counts days inclusively", () => {
		expect(inclusiveDaySpan("2026-11-01", "2026-11-01")).toBe(1);
		expect(inclusiveDaySpan("2026-11-01", "2026-12-01")).toBe(31);
		expect(inclusiveDaySpan("2026-11-02", "2026-11-01")).toBe(0);
	});

	it.each([
		["2026-11-11", true],
		["2026-02-30", false],
		["2026-13-01", false],
		["2026-1-1", false],
		["2026-11-11T00:00:00Z", false],
	])("isIsoDate(%s) → %s", (date, valid) => {
		expect(isIsoDate(date)).toBe(valid);
	});

	it("refuses to do arithmetic on a date that is not one", () => {
		expect(() => weekRange("2026-02-30")).toThrow(RangeError);
	});
});

const base: TimeEntryFacts = {
	projectId: "project-a",
	workDate: "2026-11-10",
	durationMinutes: 60,
	startAt: null,
	stopAt: null,
	activity: "DEVELOPMENT",
	storyId: null,
	description: "Wire the import",
};

function existing(
	id: string,
	overrides: Partial<TimeEntryFacts> = {},
): ExistingTimeEntryFacts {
	return { ...base, id, ...overrides };
}

describe("isLikelyDuplicate", () => {
	it("flags overlapping timed entries on the same project and day", () => {
		expect(
			isLikelyDuplicate(
				{
					...base,
					durationMinutes: 90,
					activity: "TESTING",
					startAt: new Date("2026-11-10T09:00:00Z"),
					stopAt: new Date("2026-11-10T10:30:00Z"),
				},
				existing("e1", {
					durationMinutes: 45,
					startAt: new Date("2026-11-10T10:00:00Z"),
					stopAt: new Date("2026-11-10T10:45:00Z"),
				}),
			),
		).toBe(true);
	});

	it("does not flag timed entries that only touch", () => {
		expect(
			isLikelyDuplicate(
				{
					...base,
					durationMinutes: 30,
					description: "Something else",
					startAt: new Date("2026-11-10T09:00:00Z"),
					stopAt: new Date("2026-11-10T09:30:00Z"),
				},
				existing("e1", {
					durationMinutes: 60,
					startAt: new Date("2026-11-10T09:30:00Z"),
					stopAt: new Date("2026-11-10T10:30:00Z"),
				}),
			),
		).toBe(false);
	});

	it("flags the same work item for the same duration", () => {
		expect(
			isLikelyDuplicate(
				{ ...base, storyId: "story-1", activity: "TESTING" },
				existing("e1", { storyId: "story-1", description: "Other" }),
			),
		).toBe(true);
	});

	it("does not flag the same work item for a different duration", () => {
		expect(
			isLikelyDuplicate(
				{
					...base,
					storyId: "story-1",
					description: "Other",
					durationMinutes: 30,
				},
				existing("e1", { storyId: "story-1" }),
			),
		).toBe(false);
	});

	it("flags the same duration, activity and description, ignoring case and spacing", () => {
		expect(
			isLikelyDuplicate(
				{ ...base, description: "  wire   the IMPORT " },
				existing("e1"),
			),
		).toBe(true);
	});

	it("treats two empty descriptions as the same", () => {
		expect(
			isLikelyDuplicate(
				{ ...base, description: null },
				existing("e1", { description: "  " }),
			),
		).toBe(true);
	});

	it("does not flag a different activity with no shared work item", () => {
		expect(
			isLikelyDuplicate({ ...base, activity: "TESTING" }, existing("e1")),
		).toBe(false);
	});

	it.each([
		["another project", { projectId: "project-b" }],
		["another day", { workDate: "2026-11-11" }],
	])("never flags a non-overlapping entry on %s", (_label, overrides) => {
		expect(isLikelyDuplicate(base, existing("e1", overrides))).toBe(false);
		expect(
			isLikelyDuplicate(
				{
					...base,
					startAt: new Date("2026-11-10T09:00:00Z"),
					stopAt: new Date("2026-11-10T10:00:00Z"),
				},
				existing("e1", {
					...overrides,
					startAt: new Date("2026-11-10T11:00:00Z"),
					stopAt: new Date("2026-11-10T12:00:00Z"),
				}),
			),
		).toBe(false);
	});

	it("flags overlapping timed entries on another project", () => {
		expect(
			isLikelyDuplicate(
				{
					...base,
					startAt: new Date("2026-11-10T09:00:00Z"),
					stopAt: new Date("2026-11-10T10:00:00Z"),
				},
				existing("e1", {
					projectId: "project-b",
					activity: "MEETINGS_COLLABORATION",
					description: "Unrelated",
					durationMinutes: 30,
					startAt: new Date("2026-11-10T09:30:00Z"),
					stopAt: new Date("2026-11-10T10:00:00Z"),
				}),
			),
		).toBe(true);
	});

	it("flags an overnight entry that overlaps the next day's entry", () => {
		expect(
			isLikelyDuplicate(
				{
					...base,
					workDate: "2026-11-10",
					durationMinutes: 180,
					startAt: new Date("2026-11-10T23:00:00Z"),
					stopAt: new Date("2026-11-11T02:00:00Z"),
				},
				existing("e1", {
					projectId: "project-b",
					workDate: "2026-11-11",
					durationMinutes: 60,
					description: "Other",
					startAt: new Date("2026-11-11T01:00:00Z"),
					stopAt: new Date("2026-11-11T02:00:00Z"),
				}),
			),
		).toBe(true);
	});
});

describe("detectTimeEntryWarnings", () => {
	it("returns nothing for an ordinary entry", () => {
		expect(
			detectTimeEntryWarnings({
				proposed: base,
				existingEntries: [
					existing("e1", {
						projectId: "project-b",
						durationMinutes: 120,
					}),
				],
			}),
		).toEqual([]);
	});

	it("names every likely duplicate", () => {
		expect(
			detectTimeEntryWarnings({
				proposed: base,
				existingEntries: [
					existing("e1"),
					existing("e2", { activity: "TESTING" }),
					existing("e3"),
				],
			}),
		).toEqual([{ code: "LIKELY_DUPLICATE", entryIds: ["e1", "e3"] }]);
	});

	it("does not warn at exactly the daily limit", () => {
		expect(
			detectTimeEntryWarnings({
				proposed: { ...base, durationMinutes: 60 },
				existingEntries: [
					existing("e1", {
						projectId: "project-b",
						durationMinutes: DAILY_TIME_LIMIT_MINUTES - 60,
					}),
				],
			}),
		).toEqual([]);
	});

	it("warns one minute over the daily limit, counting every project", () => {
		expect(
			detectTimeEntryWarnings({
				proposed: { ...base, durationMinutes: 61 },
				existingEntries: [
					existing("e1", {
						projectId: "project-b",
						durationMinutes: 450,
					}),
					existing("e2", {
						projectId: "project-c",
						durationMinutes: 450,
					}),
				],
			}),
		).toEqual([
			{ code: "OVER_DAILY_LIMIT", totalMinutes: 961, limitMinutes: 960 },
		]);
	});

	it("ignores entries on other work dates", () => {
		expect(
			detectTimeEntryWarnings({
				proposed: { ...base, durationMinutes: 600 },
				existingEntries: [
					existing("e1", {
						workDate: "2026-11-11",
						durationMinutes: 600,
					}),
				],
			}),
		).toEqual([]);
	});

	it("names an overlapping entry on another work date without counting it toward the daily total", () => {
		expect(
			detectTimeEntryWarnings({
				proposed: {
					...base,
					durationMinutes: 180,
					startAt: new Date("2026-11-10T23:00:00Z"),
					stopAt: new Date("2026-11-11T02:00:00Z"),
				},
				existingEntries: [
					existing("e1", {
						projectId: "project-b",
						workDate: "2026-11-11",
						durationMinutes: 900,
						startAt: new Date("2026-11-11T01:00:00Z"),
						stopAt: new Date("2026-11-11T16:00:00Z"),
					}),
				],
			}),
		).toEqual([{ code: "LIKELY_DUPLICATE", entryIds: ["e1"] }]);
	});

	it("does not count the entry being edited, nor call it its own duplicate", () => {
		const original = existing("e1", { durationMinutes: 900 });
		expect(
			detectTimeEntryWarnings({
				proposed: { ...base, durationMinutes: 960 },
				existingEntries: [original],
				editingEntryId: "e1",
			}),
		).toEqual([]);
	});

	it("still counts the other entries when editing", () => {
		expect(
			detectTimeEntryWarnings({
				proposed: {
					...base,
					durationMinutes: 500,
					description: "Edited",
				},
				existingEntries: [
					existing("e1", {
						durationMinutes: 400,
						description: "Original",
					}),
					existing("e2", {
						projectId: "project-b",
						durationMinutes: 461,
					}),
				],
				editingEntryId: "e1",
			}),
		).toEqual([
			{ code: "OVER_DAILY_LIMIT", totalMinutes: 961, limitMinutes: 960 },
		]);
	});
});
