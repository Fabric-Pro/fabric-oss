/**
 * The running timer's widget rules, without React: the time it shows from
 * the last read, when it shows, what Stop does first, a picked stop time
 * (overnight included), the once-per-timer reminder, how an audit action is
 * read back in the forgotten-timer question, the stored "Saved" outcome, and
 * the timer a CONFLICT carries.
 */

import { ORPCError } from "@orpc/client";
import {
	addRemindedTimer,
	conflictTimer,
	describeActivityAction,
	formatElapsed,
	openSegmentSeconds,
	parseRemindedTimers,
	parseSavedTimer,
	pickedStopAt,
	reminderDue,
	reminderNeedsProposal,
	savedTimerFrom,
	stopStep,
	type TimerView,
	timerDotState,
	timerElapsedAt,
	timerRefetchInterval,
	widgetContent,
} from "@saas/time-tracking/lib/timer-model";
import { describe, expect, it } from "vitest";

const HOUR = 3600;

function timerFixture(overrides: Partial<TimerView> = {}): TimerView {
	return {
		id: "timer-1",
		projectId: "project-1",
		projectName: "Example project",
		activity: "DEVELOPMENT",
		storyId: "story-1",
		storyIdentifier: "F-12",
		storyTitle: "Example feature",
		description: null,
		billable: null,
		timezone: "Europe/Berlin",
		status: "RUNNING",
		version: 3,
		segments: [
			{
				startAt: "2026-11-11T08:00:00.000Z",
				stopAt: "2026-11-11T09:00:00.000Z",
			},
			{ startAt: "2026-11-11T09:30:00.000Z", stopAt: null },
		],
		elapsedSeconds: 2 * HOUR,
		startStopRequired: false,
		defaultBillable: true,
		createdAt: "2026-11-11T08:00:00.000Z",
		updatedAt: "2026-11-11T09:30:00.000Z",
		...overrides,
	};
}

const FETCHED_AT = Date.parse("2026-11-11T10:30:00.000Z");

describe("timerElapsedAt", () => {
	it("adds the time since the read while the timer runs", () => {
		expect(
			timerElapsedAt(timerFixture(), FETCHED_AT, FETCHED_AT + 65_500),
		).toBe(2 * HOUR + 65);
	});

	it("does not move while the timer is paused", () => {
		expect(
			timerElapsedAt(
				timerFixture({ status: "PAUSED" }),
				FETCHED_AT,
				FETCHED_AT + 10 * HOUR * 1000,
			),
		).toBe(2 * HOUR);
	});

	it("never goes back when the clock reads before the read", () => {
		expect(
			timerElapsedAt(timerFixture(), FETCHED_AT, FETCHED_AT - 5_000),
		).toBe(2 * HOUR);
	});
});

describe("openSegmentSeconds", () => {
	it("is the elapsed time less the closed segments", () => {
		// Two hours elapsed, one of them in the closed first segment.
		expect(openSegmentSeconds(timerFixture(), FETCHED_AT, FETCHED_AT)).toBe(
			HOUR,
		);
	});

	it("is null for a paused timer", () => {
		expect(
			openSegmentSeconds(
				timerFixture({ status: "PAUSED" }),
				FETCHED_AT,
				FETCHED_AT,
			),
		).toBeNull();
	});
});

describe("formatElapsed", () => {
	it.each([
		[0, "0:00:00"],
		[6128, "1:42:08"],
		[30 * HOUR + 59, "30:00:59"],
		[-4, "0:00:00"],
	])("%i seconds reads %s", (seconds, expected) => {
		expect(formatElapsed(seconds)).toBe(expected);
	});
});

describe("timerDotState", () => {
	it("is a ring while paused, however long", () => {
		expect(
			timerDotState(
				timerFixture({ status: "PAUSED", elapsedSeconds: 20 * HOUR }),
				FETCHED_AT,
				FETCHED_AT,
			),
		).toBe("paused");
	});

	it("turns amber once the running segment reaches eight hours", () => {
		const timer = timerFixture({ elapsedSeconds: HOUR + 8 * HOUR - 1 });
		expect(timerDotState(timer, FETCHED_AT, FETCHED_AT)).toBe("running");
		expect(timerDotState(timer, FETCHED_AT, FETCHED_AT + 1_000)).toBe(
			"long",
		);
	});
});

describe("widgetContent", () => {
	it.each([
		[false, false, "SHOWN", false, "none"],
		[true, false, "SHOWN", false, "timer"],
		[true, false, "HIDDEN_UNTIL_START", false, "none"],
		[true, false, "OFF", false, "none"],
		[true, false, "OFF", true, "timer"],
		[true, true, "SHOWN", false, "timer"],
		[false, true, "SHOWN", false, "saved"],
		[false, true, "HIDDEN_UNTIL_START", false, "saved"],
		[false, true, "OFF", false, "none"],
	] as const)(
		"timer %s, saved %s, widget %s, revealed %s: %s",
		(hasTimer, hasSaved, widget, revealed, expected) => {
			expect(
				widgetContent({ hasTimer, hasSaved, widget, revealed }),
			).toBe(expected);
		},
	);
});

describe("stopStep", () => {
	it("stops now when the server does not ask", () => {
		expect(
			stopStep({
				needsQuestion: false,
				proposedStopAt: "2026-11-11T10:30:00.000Z",
				source: null,
			}),
		).toEqual({ kind: "stopNow" });
	});

	it("asks with the proposed time and where it came from", () => {
		const source = {
			action: "activity.projects.stories.update",
			at: "2026-11-11T17:42:00.000Z",
		};
		expect(
			stopStep({
				needsQuestion: true,
				proposedStopAt: source.at,
				source,
			}),
		).toEqual({ kind: "ask", proposedStopAt: source.at, source });
	});

	it("asks without a source when nothing happened since the start", () => {
		expect(
			stopStep({
				needsQuestion: true,
				proposedStopAt: "2026-11-11T08:00:00.000Z",
				source: null,
			}),
		).toEqual({
			kind: "ask",
			proposedStopAt: "2026-11-11T08:00:00.000Z",
			source: null,
		});
	});
});

describe("pickedStopAt", () => {
	// Started yesterday at 09:12:30 Berlin time; it is now 08:55 the next day.
	const openStartAt = "2026-11-11T08:12:30.000Z";
	const nowMs = Date.parse("2026-11-12T07:55:00.000Z");
	const pick = (time: string) =>
		pickedStopAt({ time, openStartAt, nowMs, timeZone: "Europe/Berlin" });

	it("reads a time later than now as yesterday evening", () => {
		expect(pick("18:42")).toBe("2026-11-11T18:42:00+01:00");
	});

	it("reads a time before now as today", () => {
		expect(pick("08:30")).toBe("2026-11-12T08:30:00+01:00");
	});

	it("refuses a time before the running segment started", () => {
		expect(pick("09:00")).toBeNull();
	});

	it("stops at the start for a pick in the minute it started", () => {
		expect(pick("09:12")).toBe(openStartAt);
	});

	it("refuses what is not a time of day", () => {
		expect(pick("9")).toBeNull();
		expect(pick("")).toBeNull();
	});
});

describe("reminderDue", () => {
	const due = {
		status: "RUNNING" as const,
		remindersOn: true,
		alreadyReminded: false,
		openSeconds: 4 * HOUR,
		stopQuestionDue: false,
	};

	it("fires once a running segment reaches four hours", () => {
		expect(reminderDue(due)).toBe(true);
		expect(reminderDue({ ...due, openSeconds: 4 * HOUR - 1 })).toBe(false);
	});

	it("fires earlier when Stop would ask when work stopped", () => {
		expect(
			reminderDue({ ...due, openSeconds: HOUR, stopQuestionDue: true }),
		).toBe(true);
	});

	it("never fires twice for the same timer", () => {
		expect(reminderDue({ ...due, alreadyReminded: true })).toBe(false);
	});

	it("never fires for a paused timer or with reminders off", () => {
		expect(
			reminderDue({ ...due, status: "PAUSED", openSeconds: null }),
		).toBe(false);
		expect(reminderDue({ ...due, remindersOn: false })).toBe(false);
	});
});

describe("reminderNeedsProposal", () => {
	it.each([
		[null, false],
		[10 * 60, false],
		[30 * 60, true],
		[4 * HOUR - 1, true],
		[4 * HOUR, false],
	])("%s seconds: %s", (openSeconds, expected) => {
		expect(reminderNeedsProposal(openSeconds)).toBe(expected);
	});
});

describe("reminded timers", () => {
	it("adds a timer once, newest last", () => {
		expect(addRemindedTimer(["a", "b"], "a")).toEqual(["b", "a"]);
	});

	it("keeps the twenty newest", () => {
		const ids = Array.from({ length: 20 }, (_, index) => `t${index}`);
		const next = addRemindedTimer(ids, "new");
		expect(next).toHaveLength(20);
		expect(next[0]).toBe("t1");
		expect(next[next.length - 1]).toBe("new");
	});

	it("reads back only stored ids", () => {
		expect(parseRemindedTimers('["a", 3, "b"]')).toEqual(["a", "b"]);
		expect(parseRemindedTimers("{")).toEqual([]);
		expect(parseRemindedTimers('{"a":1}')).toEqual([]);
		expect(parseRemindedTimers(null)).toEqual([]);
	});
});

describe("timerRefetchInterval", () => {
	const reread = (
		hasTimer: boolean,
		remindersOn: boolean,
		tabVisible: boolean,
	) =>
		timerRefetchInterval({
			hasTimer,
			remindersOn,
			tabVisible,
			intervalMs: 60_000,
		});

	it("keeps a hidden tab rereading while reminders are on, so the reminder can fire", () => {
		expect(reread(true, true, false)).toBe(60_000);
	});

	it("rereads in a visible tab whatever the reminder setting", () => {
		expect(reread(true, false, true)).toBe(60_000);
	});

	it("lets a hidden tab rest when reminders are off", () => {
		expect(reread(true, false, false)).toBe(false);
	});

	it("never rereads without a timer", () => {
		expect(reread(false, true, true)).toBe(false);
	});
});

describe("describeActivityAction", () => {
	it.each([
		["activity.projects.stories.update", "edited", "workItem"],
		["activity.projects.stories.testCases.create", "created", "testCase"],
		["activity.projects.deleteDocument", "deleted", "document"],
		["activity.agents.run", "worked", "agent"],
		["activity.todos.complete", "worked", "todo"],
		["activity.projects.updateProject", "edited", "project"],
		["activity.timeTracking.createEntry", "created", "time"],
		["activity.timeTracking.generateSuggestions", "worked", "time"],
		["activity.projects.documents.generate", "created", "document"],
	])("%s reads as %s %s", (action, verb, object) => {
		expect(describeActivityAction(action)).toEqual({ verb, object });
	});

	it("falls back for an area it cannot name", () => {
		expect(describeActivityAction("activity.integrations.sync")).toBeNull();
	});

	it("falls back for an action outside the activity namespace", () => {
		expect(describeActivityAction("story.update")).toBeNull();
	});
});

describe("the saved outcome", () => {
	const entries = [
		{ id: "entry-1", durationMinutes: 60, workDate: "2026-11-11" },
		{ id: "entry-2", durationMinutes: 42, workDate: "2026-11-11" },
	];

	it("sums the entries and keeps what Start again needs", () => {
		expect(
			savedTimerFrom({
				organizationId: "org-1",
				timer: timerFixture(),
				entries,
			}),
		).toEqual({
			organizationId: "org-1",
			timerId: "timer-1",
			projectId: "project-1",
			projectName: "Example project",
			activity: "DEVELOPMENT",
			story: {
				id: "story-1",
				identifier: "F-12",
				title: "Example feature",
			},
			entryIds: ["entry-1", "entry-2"],
			totalMinutes: 102,
			workDate: "2026-11-11",
		});
	});

	it("survives the round trip through storage", () => {
		const saved = savedTimerFrom({
			organizationId: "org-1",
			timer: timerFixture({
				storyId: null,
				storyIdentifier: null,
				storyTitle: null,
			}),
			entries,
		});
		expect(saved.story).toBeNull();
		expect(parseSavedTimer(JSON.stringify(saved))).toEqual(saved);
	});

	it("ignores what is not a saved outcome", () => {
		expect(parseSavedTimer(null)).toBeNull();
		expect(parseSavedTimer("not json")).toBeNull();
		expect(
			parseSavedTimer(
				JSON.stringify({
					...savedTimerFrom({
						organizationId: "org-1",
						timer: timerFixture(),
						entries,
					}),
					activity: "NAPPING",
				}),
			),
		).toBeNull();
	});
});

describe("conflictTimer", () => {
	it("adopts the timer a CONFLICT carries", () => {
		const timer = timerFixture({ version: 7 });
		expect(
			conflictTimer(new ORPCError("CONFLICT", { data: { timer } })),
		).toEqual(timer);
	});

	it("ignores other errors and a CONFLICT without a timer", () => {
		expect(
			conflictTimer(
				new ORPCError("NOT_FOUND", { data: { timer: timerFixture() } }),
			),
		).toBeNull();
		expect(
			conflictTimer(
				new ORPCError("CONFLICT", { data: { timer: { id: 1 } } }),
			),
		).toBeNull();
		expect(conflictTimer(new Error("offline"))).toBeNull();
	});
});
