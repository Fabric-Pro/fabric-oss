/**
 * The save request the entry form builds from what was typed, and the view
 * state the My time page reads from its URL.
 */

import {
	buildEntryFields,
	draftFromEntry,
	draftTimedMinutes,
	type EntryDraft,
	emptyDraft,
	nextUnansweredWarning,
} from "@saas/time-tracking/lib/entry-draft";
import type { TimeEntry } from "@saas/time-tracking/lib/time-entry-model";
import { resolveViewState } from "@saas/time-tracking/lib/view-state";
import { describe, expect, it } from "vitest";

function draft(overrides: Partial<EntryDraft> = {}): EntryDraft {
	return {
		...emptyDraft({
			projectId: "project-a",
			activity: "DEVELOPMENT",
			workDate: "2026-11-11",
			timezone: "Europe/Berlin",
		}),
		...overrides,
	};
}

const NO_ACKS = { acknowledgedWarnings: [] };

describe("buildEntryFields — duration entries", () => {
	it("sends the parsed duration and no times", () => {
		const result = buildEntryFields(draft({ durationText: "1h 30m" }), {
			timed: false,
			...NO_ACKS,
		});

		expect(result).toEqual({
			ok: true,
			fields: {
				projectId: "project-a",
				workDate: "2026-11-11",
				timezone: "Europe/Berlin",
				activity: "DEVELOPMENT",
				description: null,
				storyId: null,
				acknowledgedWarnings: [],
				durationMinutes: 90,
			},
		});
	});

	it("leaves billable to the server's default until it is chosen", () => {
		const untouched = buildEntryFields(draft({ durationText: "2h" }), {
			timed: false,
			...NO_ACKS,
		});
		const chosen = buildEntryFields(
			draft({ durationText: "2h", billable: false }),
			{ timed: false, ...NO_ACKS },
		);

		expect(untouched.ok && "billable" in untouched.fields).toBe(false);
		expect(chosen.ok && chosen.fields.billable).toBe(false);
	});

	it("trims the note and sends a blank one as null", () => {
		const result = buildEntryFields(
			draft({
				durationText: "45m",
				description: "  Paired on the export  ",
			}),
			{ timed: false, ...NO_ACKS },
		);
		const blank = buildEntryFields(
			draft({ durationText: "45m", description: "   " }),
			{ timed: false, ...NO_ACKS },
		);

		expect(result.ok && result.fields.description).toBe(
			"Paired on the export",
		);
		expect(blank.ok && blank.fields.description).toBeNull();
	});

	it("sends the work item and the acknowledged warnings", () => {
		const result = buildEntryFields(
			draft({
				durationText: "1h",
				story: { id: "story-1", identifier: "212", title: "Export" },
			}),
			{ timed: false, acknowledgedWarnings: ["LIKELY_DUPLICATE"] },
		);

		expect(result.ok && result.fields.storyId).toBe("story-1");
		expect(result.ok && result.fields.acknowledgedWarnings).toEqual([
			"LIKELY_DUPLICATE",
		]);
	});

	it.each([
		["", "duration"],
		["soon", "duration"],
		["25h", "tooLong"],
	])("refuses %j as %s", (durationText, problem) => {
		expect(
			buildEntryFields(draft({ durationText }), {
				timed: false,
				...NO_ACKS,
			}),
		).toEqual({ ok: false, problem });
	});

	it("needs a project", () => {
		expect(
			buildEntryFields(draft({ projectId: null, durationText: "1h" }), {
				timed: false,
				...NO_ACKS,
			}),
		).toEqual({ ok: false, problem: "project" });
	});
});

describe("buildEntryFields — start and stop entries", () => {
	it("sends both instants with the zone's offset and no duration", () => {
		const result = buildEntryFields(
			draft({
				startTime: "22:00",
				stopTime: "01:30",
				stopsNextDay: true,
			}),
			{ timed: true, ...NO_ACKS },
		);

		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.fields.startAt).toBe("2026-11-11T22:00:00+01:00");
			expect(result.fields.stopAt).toBe("2026-11-12T01:30:00+01:00");
			expect(result.fields.durationMinutes).toBeUndefined();
		}
	});

	it("refuses missing times and a stop before the start", () => {
		expect(
			buildEntryFields(draft({ startTime: "09:00" }), {
				timed: true,
				...NO_ACKS,
			}),
		).toEqual({ ok: false, problem: "times" });
		expect(
			buildEntryFields(draft({ startTime: "10:00", stopTime: "09:00" }), {
				timed: true,
				...NO_ACKS,
			}),
		).toEqual({ ok: false, problem: "stopBeforeStart" });
	});

	it("shows the calculated duration as the times are typed", () => {
		expect(draftTimedMinutes(draft({ startTime: "09:00" }))).toBeNull();
		expect(
			draftTimedMinutes(draft({ startTime: "09:00", stopTime: "10:15" })),
		).toBe(75);
	});
});

describe("draftFromEntry", () => {
	const base: TimeEntry = {
		id: "entry-1",
		projectId: "project-a",
		projectName: "Alpha",
		workDate: "2026-11-11",
		timezone: "Europe/Berlin",
		durationMinutes: 210,
		startAt: "2026-11-11T21:00:00.000Z",
		stopAt: "2026-11-12T00:30:00.000Z",
		activity: "TESTING",
		billable: false,
		description: "Night release",
		storyId: "story-1",
		storyIdentifier: "212",
		storyTitle: "Export",
		startStopRequired: true,
		createdAt: "2026-11-11T21:00:00.000Z",
		updatedAt: "2026-11-11T21:00:00.000Z",
	};

	it("opens a timed entry on its own zone's wall clock, stopping the next day", () => {
		expect(draftFromEntry(base)).toMatchObject({
			startTime: "22:00",
			stopTime: "01:30",
			stopsNextDay: true,
			durationText: "",
			billable: false,
			description: "Night release",
			story: { id: "story-1", identifier: "212", title: "Export" },
		});
	});

	it("opens a duration entry with its duration typed out", () => {
		expect(
			draftFromEntry({
				...base,
				startAt: null,
				stopAt: null,
				startStopRequired: false,
			}),
		).toMatchObject({
			durationText: "3h 30m",
			startTime: "",
			stopTime: "",
		});
	});
});

describe("nextUnansweredWarning", () => {
	const warnings = [
		{ code: "LIKELY_DUPLICATE" as const, entryIds: ["entry-1"] },
		{
			code: "OVER_DAILY_LIMIT" as const,
			totalMinutes: 1000,
			limitMinutes: 960,
		},
	];

	it("asks one question at a time, in order", () => {
		expect(nextUnansweredWarning(warnings, [])?.code).toBe(
			"LIKELY_DUPLICATE",
		);
		expect(
			nextUnansweredWarning(warnings, ["LIKELY_DUPLICATE"])?.code,
		).toBe("OVER_DAILY_LIMIT");
		expect(
			nextUnansweredWarning(warnings, [
				"LIKELY_DUPLICATE",
				"OVER_DAILY_LIMIT",
			]),
		).toBeNull();
	});
});

describe("resolveViewState", () => {
	it("reads the view and date from the URL", () => {
		expect(
			resolveViewState({
				view: "day",
				date: "2026-11-10",
				rememberedView: "week",
				today: "2026-11-11",
			}),
		).toEqual({ view: "day", date: "2026-11-10" });
	});

	it("falls back to the remembered view, then the week, and to today", () => {
		expect(
			resolveViewState({
				view: null,
				date: "2026-02-30",
				rememberedView: "day",
				today: "2026-11-11",
			}),
		).toEqual({ view: "day", date: "2026-11-11" });
		expect(
			resolveViewState({
				view: "month",
				date: null,
				rememberedView: null,
				today: "2026-11-11",
			}),
		).toEqual({ view: "week", date: "2026-11-11" });
	});
});
