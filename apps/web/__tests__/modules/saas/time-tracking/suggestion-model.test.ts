/**
 * The "To confirm" list: what a row starts from, the confirm request built
 * from what was typed in its duration slot, which rows the batch confirm
 * takes, and how the page polls and follows a generation run.
 */

import {
	batchConfirmable,
	buildConfirmFields,
	evidenceTimeRange,
	followRun,
	type SuggestionDraft,
	suggestedWorkDates,
	suggestionDraft,
	suggestionPollInterval,
	type TimeSuggestion,
} from "@saas/time-tracking/lib/suggestion-model";
import { describe, expect, it } from "vitest";

/** A Berlin morning in November (UTC+1): 09:10 to 11:40 local. */
const START_AT = "2026-11-10T08:10:00.000Z";
const STOP_AT = "2026-11-10T10:40:00.000Z";

function suggestion(overrides: Partial<TimeSuggestion> = {}): TimeSuggestion {
	return {
		id: "suggestion-1",
		projectId: "project-a",
		projectName: "Alpha",
		workDate: "2026-11-10",
		timezone: "Europe/Berlin",
		activity: "TESTING",
		billable: null,
		durationMinutes: null,
		startAt: null,
		stopAt: null,
		description: "Testing the checkout flow",
		explanation: "Suggested from 3 recorded test results.",
		storyId: null,
		storyIdentifier: null,
		storyTitle: null,
		status: "PENDING",
		expiresAt: "2026-11-23T23:00:00.000Z",
		createdAt: "2026-11-11T09:00:00.000Z",
		startStopRequired: false,
		defaultBillable: false,
		evidence: [],
		...overrides,
	};
}

const timed = (overrides: Partial<TimeSuggestion> = {}) =>
	suggestion({
		durationMinutes: 150,
		startAt: START_AT,
		stopAt: STOP_AT,
		...overrides,
	});

function draftOf(
	item: TimeSuggestion,
	patch: Partial<SuggestionDraft> = {},
): SuggestionDraft {
	return { ...suggestionDraft(item), ...patch };
}

describe("suggestionDraft", () => {
	it("leaves the duration blank when nothing proves one", () => {
		expect(suggestionDraft(suggestion()).durationText).toBe("");
	});

	it("fills the duration and times from a real span", () => {
		const draft = suggestionDraft(timed());

		expect(draft.durationText).toBe("2h 30m");
		expect(draft.startTime).toBe("09:10");
		expect(draft.stopTime).toBe("11:40");
		expect(draft.stopsNextDay).toBe(false);
	});

	it("takes the project's billable default only when the suggestion has none", () => {
		expect(suggestionDraft(suggestion()).billable).toBe(false);
		expect(suggestionDraft(suggestion({ billable: true })).billable).toBe(
			true,
		);
	});
});

describe("buildConfirmFields — duration slot", () => {
	it("sends a typed duration as the approval", () => {
		const item = suggestion();
		const result = buildConfirmFields(
			item,
			draftOf(item, { durationText: "1h 30m" }),
		);

		expect(result).toEqual({
			ok: true,
			fields: {
				suggestionId: "suggestion-1",
				timezone: "Europe/Berlin",
				activity: "TESTING",
				billable: false,
				description: "Testing the checkout flow",
				storyId: null,
				acknowledgedWarnings: [],
				durationMinutes: 90,
			},
		});
	});

	it("refuses a blank or unreadable duration", () => {
		const item = suggestion();

		expect(buildConfirmFields(item, draftOf(item))).toEqual({
			ok: false,
			problem: "duration",
		});
		expect(
			buildConfirmFields(item, draftOf(item, { durationText: "soon" })),
		).toEqual({ ok: false, problem: "duration" });
	});

	it("refuses more than a day", () => {
		const item = suggestion();

		expect(
			buildConfirmFields(item, draftOf(item, { durationText: "25h" })),
		).toEqual({ ok: false, problem: "tooLong" });
	});

	it("sends no time for an untouched span, so its start and stop are kept", () => {
		const item = timed();
		const result = buildConfirmFields(item, draftOf(item));

		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.fields).not.toHaveProperty("durationMinutes");
			expect(result.fields).not.toHaveProperty("startAt");
		}
	});

	it("sends the typed duration when the span's duration was changed", () => {
		const item = timed();
		const result = buildConfirmFields(
			item,
			draftOf(item, { durationText: "2h" }),
		);

		expect(result.ok && result.fields.durationMinutes).toBe(120);
	});

	it("sends a cleared note as null", () => {
		const item = suggestion();
		const result = buildConfirmFields(
			item,
			draftOf(item, { durationText: "45m", description: "   " }),
		);

		expect(result.ok && result.fields.description).toBeNull();
	});
});

describe("buildConfirmFields — start and stop required", () => {
	it("sends the span's times in the suggestion's zone", () => {
		const item = timed({ startStopRequired: true });
		const result = buildConfirmFields(item, draftOf(item));

		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.fields.startAt).toBe("2026-11-10T09:10:00+01:00");
			expect(result.fields.stopAt).toBe("2026-11-10T11:40:00+01:00");
			expect(result.fields).not.toHaveProperty("durationMinutes");
		}
	});

	it("asks for both times when the suggestion has none", () => {
		const item = suggestion({ startStopRequired: true });

		expect(buildConfirmFields(item, draftOf(item))).toEqual({
			ok: false,
			problem: "times",
		});
		expect(
			buildConfirmFields(
				item,
				draftOf(item, { startTime: "14:00", stopTime: "13:00" }),
			),
		).toEqual({ ok: false, problem: "stopBeforeStart" });
	});
});

describe("batchConfirmable", () => {
	it("offers nothing for fewer than two rows with a real span", () => {
		expect(batchConfirmable([suggestion(), timed({ id: "b" })])).toEqual(
			[],
		);
	});

	it("takes only the rows with a real span, in list order", () => {
		const rows = [
			timed({ id: "a" }),
			suggestion({ id: "b", durationMinutes: 60 }),
			timed({ id: "c" }),
		];

		expect(batchConfirmable(rows).map((row) => row.id)).toEqual(["a", "c"]);
	});
});

describe("suggestedWorkDates", () => {
	it("lists each work date with a waiting suggestion once", () => {
		expect([
			...suggestedWorkDates([
				{ workDate: "2026-11-10" },
				{ workDate: "2026-11-10" },
				{ workDate: "2026-11-12" },
			]),
		]).toEqual(["2026-11-10", "2026-11-12"]);
	});
});

describe("generation run polling", () => {
	const run = (
		status: "GENERATING" | "DONE" | "FAILED",
		createdCount = 0,
	) => ({
		runId: "run-1",
		status,
		createdCount,
		startedAt: "2026-11-11T09:00:00.000Z",
		finishedAt: status === "GENERATING" ? null : "2026-11-11T09:01:00.000Z",
	});

	it("polls every two seconds while the run is generating", () => {
		expect(suggestionPollInterval(run("GENERATING"))).toBe(2_000);
	});

	it("stops polling once the run is done or failed, or when there is none", () => {
		expect(suggestionPollInterval(run("DONE"))).toBe(false);
		expect(suggestionPollInterval(run("FAILED"))).toBe(false);
		expect(suggestionPollInterval(null)).toBe(false);
		expect(suggestionPollInterval(undefined)).toBe(false);
	});

	const loud = { loudRunId: "run-1", quietRunId: null };
	const quiet = { loudRunId: null, quietRunId: "run-1" };
	const none = { loudRunId: null, quietRunId: null };

	it("reports how a run the member asked for ended", () => {
		expect(followRun(loud, run("GENERATING")).ended).toBeNull();
		expect(followRun(loud, run("FAILED")).ended).toBe("failed");
		expect(followRun(loud, run("DONE", 0)).ended).toBe("empty");
		expect(followRun(loud, run("DONE", 3)).ended).toBe("found");
		expect(followRun(loud, run("DONE", 3)).followed).toEqual(none);
	});

	it("says nothing about a run it is not following", () => {
		expect(followRun(none, run("DONE", 3))).toEqual({
			followed: none,
			ended: null,
		});
		expect(
			followRun({ loudRunId: "run-2", quietRunId: null }, run("FAILED"))
				.ended,
		).toBeNull();
		expect(followRun(none, undefined).ended).toBeNull();
		expect(followRun(none, null).ended).toBeNull();
	});

	it("keeps the same object while nothing changes, so the page does not re-render", () => {
		expect(followRun(loud, run("GENERATING")).followed).toBe(loud);
		expect(followRun(quiet, run("GENERATING")).followed).toBe(quiet);
		expect(followRun(none, run("DONE")).followed).toBe(none);
	});

	describe("automatic runs are silent", () => {
		it("follows a run it did not start quietly", () => {
			expect(followRun(none, run("GENERATING"))).toEqual({
				followed: quiet,
				ended: null,
			});
		});

		it("ends a quiet run with a list reload and no outcome", () => {
			for (const ended of [
				run("DONE", 0),
				run("DONE", 4),
				run("FAILED"),
			]) {
				expect(followRun(quiet, ended)).toEqual({
					followed: none,
					ended: "quiet",
				});
			}
		});

		it("lets a run that starts while the member waits inherit the wait", () => {
			const waiting = { loudRunId: "run-0", quietRunId: null };
			expect(followRun(waiting, run("GENERATING")).followed).toEqual(
				loud,
			);
		});

		it("reports a quiet run the member then asked about as theirs", () => {
			const both = { loudRunId: "run-1", quietRunId: "run-1" };
			expect(followRun(both, run("DONE", 0))).toEqual({
				followed: none,
				ended: "empty",
			});
		});
	});
});

describe("evidenceTimeRange", () => {
	it("spans the earliest to the latest evidence in the suggestion's zone", () => {
		expect(
			evidenceTimeRange(
				[
					{
						kind: "FEATURE_EDIT",
						count: 3,
						earliestAt: "2026-11-10T09:00:00.000Z",
						latestAt: "2026-11-10T10:40:00.000Z",
					},
					{
						kind: "TEST_RUN",
						count: 1,
						earliestAt: START_AT,
						latestAt: START_AT,
					},
				],
				"Europe/Berlin",
			),
		).toBe("09:10–11:40");
	});

	it("shows one time for a single instant and nothing without evidence", () => {
		expect(
			evidenceTimeRange(
				[
					{
						kind: "TEST_RUN",
						count: 1,
						earliestAt: START_AT,
						latestAt: START_AT,
					},
				],
				"Europe/Berlin",
			),
		).toBe("09:10");
		expect(evidenceTimeRange([], "Europe/Berlin")).toBeNull();
	});
});
