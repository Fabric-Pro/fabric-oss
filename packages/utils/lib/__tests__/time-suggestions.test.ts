import { describe, expect, it } from "vitest";
import {
	activityForEvidenceKind,
	fallbackTimeSuggestionDescription,
	groupTimeEvidence,
	type LoggedTimeEntry,
	localDateOf,
	localTimeOf,
	mergeIntervals,
	normalizeSuggestionDescription,
	subtractIntervals,
	suggestsTimeAutomatically,
	summarizeTimeEvidence,
	TIME_EVIDENCE_KIND_VALUES,
	type TimeEvidence,
	timeSuggestionExpiry,
	timeSuggestionExplanation,
	zonedMidnight,
} from "../time-suggestions";

const at = (iso: string) => new Date(iso);

function span(
	sourceId: string,
	startIso: string,
	endIso: string,
	overrides: Partial<TimeEvidence> = {},
): TimeEvidence {
	return {
		kind: "MEETING_SESSION",
		sourceId,
		projectId: "project-a",
		storyId: null,
		occurredAt: at(startIso),
		startAt: at(startIso),
		endAt: at(endIso),
		...overrides,
	};
}

function instant(
	sourceId: string,
	iso: string,
	overrides: Partial<TimeEvidence> = {},
): TimeEvidence {
	return {
		kind: "TEST_RESULT",
		sourceId,
		projectId: "project-a",
		storyId: null,
		occurredAt: at(iso),
		startAt: null,
		endAt: null,
		...overrides,
	};
}

describe("dates in a time zone", () => {
	it("reads the local date and time of an instant", () => {
		expect(localDateOf(at("2026-11-03T23:30:00Z"), "Europe/Berlin")).toBe(
			"2026-11-04",
		);
		expect(localDateOf(at("2026-11-03T23:30:00Z"), "UTC")).toBe(
			"2026-11-03",
		);
		expect(localTimeOf(at("2026-11-03T08:05:00Z"), "Europe/Berlin")).toBe(
			"09:05",
		);
	});

	it("finds local midnight on both sides of a daylight-saving change", () => {
		// Clocks go forward in Berlin at 02:00 on 2026-03-29.
		expect(zonedMidnight("2026-03-29", "Europe/Berlin").toISOString()).toBe(
			"2026-03-28T23:00:00.000Z",
		);
		expect(zonedMidnight("2026-03-30", "Europe/Berlin").toISOString()).toBe(
			"2026-03-29T22:00:00.000Z",
		);
		expect(
			zonedMidnight("2026-11-02", "America/New_York").toISOString(),
		).toBe("2026-11-02T05:00:00.000Z");
	});
});

describe("timeSuggestionExpiry", () => {
	it("ends with the Sunday of the week after the work date", () => {
		// Wednesday 2026-11-04: its week ends Sunday 11-08, the next on 11-15.
		expect(timeSuggestionExpiry("2026-11-04", "UTC").toISOString()).toBe(
			"2026-11-16T00:00:00.000Z",
		);
		// A Sunday is the last day of its own week.
		expect(timeSuggestionExpiry("2026-11-08", "UTC").toISOString()).toBe(
			"2026-11-16T00:00:00.000Z",
		);
		// A Monday starts a new one.
		expect(timeSuggestionExpiry("2026-11-09", "UTC").toISOString()).toBe(
			"2026-11-23T00:00:00.000Z",
		);
	});

	it("ends at local midnight after a daylight-saving change", () => {
		// The expiry Monday, 2026-03-30, is the first day of summer time.
		expect(
			timeSuggestionExpiry("2026-03-18", "Europe/Berlin").toISOString(),
		).toBe("2026-03-29T22:00:00.000Z");
		// New York leaves summer time on Sunday 2026-11-01.
		expect(
			timeSuggestionExpiry(
				"2026-10-21",
				"America/New_York",
			).toISOString(),
		).toBe("2026-11-02T05:00:00.000Z");
	});

	it("crosses the year end", () => {
		// Wednesday 2026-12-30: its week ends Sunday 2027-01-03.
		expect(timeSuggestionExpiry("2026-12-30", "UTC").toISOString()).toBe(
			"2027-01-11T00:00:00.000Z",
		);
		expect(
			timeSuggestionExpiry("2026-12-30", "Asia/Tokyo").toISOString(),
		).toBe("2027-01-10T15:00:00.000Z");
	});
});

describe("intervals", () => {
	it("merges overlapping and touching intervals", () => {
		expect(
			mergeIntervals([
				{
					startAt: at("2026-11-03T10:00Z"),
					endAt: at("2026-11-03T11:00Z"),
				},
				{
					startAt: at("2026-11-03T09:00Z"),
					endAt: at("2026-11-03T10:00Z"),
				},
				{
					startAt: at("2026-11-03T10:30Z"),
					endAt: at("2026-11-03T10:45Z"),
				},
				{
					startAt: at("2026-11-03T12:00Z"),
					endAt: at("2026-11-03T13:00Z"),
				},
			]),
		).toEqual([
			{
				startAt: at("2026-11-03T09:00Z"),
				endAt: at("2026-11-03T11:00Z"),
			},
			{
				startAt: at("2026-11-03T12:00Z"),
				endAt: at("2026-11-03T13:00Z"),
			},
		]);
	});

	it("subtracts what is already covered", () => {
		expect(
			subtractIntervals(
				[
					{
						startAt: at("2026-11-03T09:00Z"),
						endAt: at("2026-11-03T12:00Z"),
					},
				],
				[
					{
						startAt: at("2026-11-03T10:00Z"),
						endAt: at("2026-11-03T10:30Z"),
					},
					{
						startAt: at("2026-11-03T11:30Z"),
						endAt: at("2026-11-03T13:00Z"),
					},
				],
			),
		).toEqual([
			{
				startAt: at("2026-11-03T09:00Z"),
				endAt: at("2026-11-03T10:00Z"),
			},
			{
				startAt: at("2026-11-03T10:30Z"),
				endAt: at("2026-11-03T11:30Z"),
			},
		]);
	});
});

describe("groupTimeEvidence", () => {
	const group = (
		evidence: TimeEvidence[],
		loggedIntervals: { startAt: Date; endAt: Date }[] = [],
		timeZone = "UTC",
		loggedEntries: LoggedTimeEntry[] = [],
	) =>
		groupTimeEvidence({
			evidence,
			timeZone,
			loggedIntervals,
			loggedEntries,
		});

	describe("evidence a confirmed entry already represents", () => {
		const pushAndEdit = [
			instant("p-1", "2026-11-03T09:00Z", {
				kind: "PULL_REQUEST",
				storyId: "story-1",
			}),
			instant("v-1", "2026-11-03T10:00Z", {
				kind: "FEATURE_EDIT",
				storyId: "story-1",
			}),
		];

		it("drops instants covered by a duration-only entry on the same project, day and work item", () => {
			expect(
				group(pushAndEdit, [], "UTC", [
					{
						projectId: "project-a",
						workDate: "2026-11-03",
						storyId: "story-1",
					},
				]),
			).toEqual([]);
		});

		it("drops instants covered by a general entry on the same project and day", () => {
			expect(
				group(pushAndEdit, [], "UTC", [
					{
						projectId: "project-a",
						workDate: "2026-11-03",
						storyId: null,
					},
				]),
			).toEqual([]);
		});

		it("dates the evidence in the member's time zone before comparing", () => {
			expect(
				group(
					[
						instant("p-1", "2026-11-03T23:30Z", {
							kind: "PULL_REQUEST",
							storyId: "story-1",
						}),
					],
					[],
					"Europe/Berlin",
					[
						{
							projectId: "project-a",
							workDate: "2026-11-04",
							storyId: "story-1",
						},
					],
				),
			).toEqual([]);
		});

		it.each([
			[
				"another work item",
				{
					projectId: "project-a",
					workDate: "2026-11-03",
					storyId: "story-2",
				},
			],
			[
				"another day",
				{
					projectId: "project-a",
					workDate: "2026-11-04",
					storyId: "story-1",
				},
			],
			[
				"another project",
				{
					projectId: "project-b",
					workDate: "2026-11-03",
					storyId: null,
				},
			],
		])("keeps instants when the entry is on %s", (_label, entry) => {
			const groups = group(pushAndEdit, [], "UTC", [entry]);
			expect(groups.map((g) => g.activity)).toEqual([
				"DEVELOPMENT",
				"PLANNING_REQUIREMENTS",
			]);
			expect(groups.every((g) => g.durationMinutes === null)).toBe(true);
		});

		it("still offers the unlogged part of a span on a day an entry covers", () => {
			const [only] = group(
				[span("m-1", "2026-11-03T09:00Z", "2026-11-03T10:00Z")],
				[],
				"UTC",
				[
					{
						projectId: "project-a",
						workDate: "2026-11-03",
						storyId: null,
					},
				],
			);
			expect(only).toMatchObject({
				durationMinutes: 60,
				startAt: at("2026-11-03T09:00Z"),
				stopAt: at("2026-11-03T10:00Z"),
			});
		});
	});

	it("merges overlapping spans into one suggestion with its start and stop", () => {
		const [only, ...rest] = group([
			span("m-1", "2026-11-03T09:00Z", "2026-11-03T10:00Z"),
			span("m-2", "2026-11-03T09:30Z", "2026-11-03T10:30Z"),
		]);
		expect(rest).toEqual([]);
		expect(only).toMatchObject({
			workDate: "2026-11-03",
			projectId: "project-a",
			activity: "MEETINGS_COLLABORATION",
			durationMinutes: 90,
			startAt: at("2026-11-03T09:00Z"),
			stopAt: at("2026-11-03T10:30Z"),
		});
		expect(only.evidence).toHaveLength(2);
	});

	it("gives separate spans their total only", () => {
		const [only] = group([
			span("m-1", "2026-11-03T09:00Z", "2026-11-03T10:00Z"),
			span("m-2", "2026-11-03T11:00Z", "2026-11-03T12:00Z"),
		]);
		expect(only).toMatchObject({
			durationMinutes: 120,
			startAt: null,
			stopAt: null,
		});
	});

	it("clips a span to the work date it started on", () => {
		const [only] = group([
			span("m-1", "2026-11-03T23:00Z", "2026-11-04T01:00Z"),
		]);
		expect(only).toMatchObject({
			workDate: "2026-11-03",
			durationMinutes: 60,
			startAt: at("2026-11-03T23:00Z"),
			stopAt: at("2026-11-04T00:00Z"),
		});
	});

	it("dates evidence in the member's time zone", () => {
		const [only] = group(
			[instant("e-1", "2026-11-03T23:30Z")],
			[],
			"Europe/Berlin",
		);
		expect(only.workDate).toBe("2026-11-04");
	});

	it("subtracts time the member already logged", () => {
		const [only] = group(
			[span("m-1", "2026-11-03T09:00Z", "2026-11-03T11:00Z")],
			[
				{
					startAt: at("2026-11-03T10:00Z"),
					endAt: at("2026-11-03T12:00Z"),
				},
			],
		);
		expect(only).toMatchObject({
			durationMinutes: 60,
			startAt: at("2026-11-03T09:00Z"),
			stopAt: at("2026-11-03T10:00Z"),
		});
	});

	it("drops a group of spans that is already logged in full", () => {
		expect(
			group(
				[span("m-1", "2026-11-03T09:00Z", "2026-11-03T10:00Z")],
				[
					{
						startAt: at("2026-11-03T08:00Z"),
						endAt: at("2026-11-03T11:00Z"),
					},
				],
			),
		).toEqual([]);
	});

	it("keeps a group whose spans are logged when it has instants too, without a duration", () => {
		const [only] = group(
			[
				// Only meetings carry a span today, so the instant is a meeting
				// kind too: the rule is about spans and instants, not kinds.
				span("m-1", "2026-11-03T09:00Z", "2026-11-03T10:00Z"),
				instant("m-2", "2026-11-03T09:30Z", {
					kind: "MEETING_SESSION",
				}),
			],
			[
				{
					startAt: at("2026-11-03T08:00Z"),
					endAt: at("2026-11-03T11:00Z"),
				},
			],
		);
		expect(only).toMatchObject({
			activity: "MEETINGS_COLLABORATION",
			durationMinutes: null,
			startAt: null,
			stopAt: null,
		});
		expect(only.evidence).toHaveLength(2);
	});

	it("never invents a duration from instants", () => {
		const [only] = group([
			instant("e-1", "2026-11-03T09:00Z"),
			instant("e-2", "2026-11-03T17:00Z"),
			instant("c-1", "2026-11-03T12:00Z", { kind: "TEST_CASE_ACTIVITY" }),
		]);
		expect(only).toMatchObject({
			activity: "TESTING",
			durationMinutes: null,
			startAt: null,
			stopAt: null,
		});
		expect(only.evidence).toHaveLength(3);
	});

	it("groups by work date, project, work item and activity", () => {
		const groups = group([
			instant("e-1", "2026-11-03T09:00Z"),
			instant("e-2", "2026-11-04T09:00Z"),
			instant("e-3", "2026-11-03T09:00Z", { projectId: "project-b" }),
			instant("v-1", "2026-11-03T09:00Z", {
				kind: "FEATURE_EDIT",
				storyId: "story-1",
			}),
			instant("v-2", "2026-11-03T10:00Z", {
				kind: "FEATURE_EDIT",
				storyId: "story-2",
			}),
		]);
		expect(
			groups.map((g) => [g.workDate, g.projectId, g.storyId, g.activity]),
		).toEqual([
			["2026-11-03", "project-a", null, "TESTING"],
			["2026-11-03", "project-a", "story-1", "PLANNING_REQUIREMENTS"],
			["2026-11-03", "project-a", "story-2", "PLANNING_REQUIREMENTS"],
			["2026-11-03", "project-b", null, "TESTING"],
			["2026-11-04", "project-a", null, "TESTING"],
		]);
	});
});

describe("activityForEvidenceKind", () => {
	it("maps every kind", () => {
		expect(
			TIME_EVIDENCE_KIND_VALUES.map((kind) =>
				activityForEvidenceKind(kind),
			),
		).toEqual([
			"MEETINGS_COLLABORATION",
			"TESTING",
			"PLANNING_REQUIREMENTS",
			"TESTING",
			"TESTING",
			"DEVELOPMENT",
		]);
	});
});

describe("wording", () => {
	const summaries = summarizeTimeEvidence([
		{
			kind: "TEST_RESULT",
			occurredAt: at("2026-11-03T10:00Z"),
			endAt: null,
		},
		{
			kind: "MEETING_SESSION",
			occurredAt: at("2026-11-03T09:00Z"),
			endAt: at("2026-11-03T09:45Z"),
		},
		{
			kind: "TEST_RESULT",
			occurredAt: at("2026-11-03T08:00Z"),
			endAt: null,
		},
	]);

	it("counts evidence per kind with its first and last time", () => {
		expect(summaries).toEqual([
			{
				kind: "MEETING_SESSION",
				count: 1,
				earliestAt: at("2026-11-03T09:00Z"),
				latestAt: at("2026-11-03T09:45Z"),
			},
			{
				kind: "TEST_RESULT",
				count: 2,
				earliestAt: at("2026-11-03T08:00Z"),
				latestAt: at("2026-11-03T10:00Z"),
			},
		]);
	});

	it("explains a suggestion by its evidence", () => {
		expect(timeSuggestionExplanation(summaries)).toBe(
			"Suggested from 1 meeting and 2 recorded test results.",
		);
	});

	it("falls back to the work item, or else the evidence", () => {
		expect(
			fallbackTimeSuggestionDescription({
				activity: "PLANNING_REQUIREMENTS",
				storyIdentifier: "F-001",
				storyTitle: "Checkout",
				summaries,
			}),
		).toBe("Planning and requirements on F-001 Checkout");
		expect(
			fallbackTimeSuggestionDescription({
				activity: "TESTING",
				storyIdentifier: null,
				storyTitle: null,
				summaries,
			}),
		).toBe("Testing: 1 meeting and 2 recorded test results");
	});

	it("stores a description as one trimmed line of at most 200 characters", () => {
		expect(normalizeSuggestionDescription("  a\n  b  ")).toBe("a b");
		expect(normalizeSuggestionDescription("   ")).toBeNull();
		expect(normalizeSuggestionDescription("x".repeat(300))).toHaveLength(
			200,
		);
	});
});

describe("suggestsTimeAutomatically", () => {
	it("fills a time and materials project's list on its own", () => {
		expect(suggestsTimeAutomatically("TIME_AND_MATERIALS")).toBe(true);
	});

	it("leaves a fixed bid project to Check my activity", () => {
		expect(suggestsTimeAutomatically("FIXED_BID")).toBe(false);
	});
});
