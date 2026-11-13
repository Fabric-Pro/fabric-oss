/**
 * Pure shaping of the caller's time suggestions for the "To confirm" list:
 * the values a row starts from, the confirm request built from what was
 * typed, which rows the batch confirm may take, and when the page stops
 * polling a generation run.
 */

import {
	addDays,
	formatDurationMinutes,
	isValidDurationMinutes,
	parseDurationInput,
	type TimeActivity,
} from "@repo/utils/time-tracking";
import type { orpcClient } from "@shared/lib/orpc-client";
import type { DraftProblem, StoryRef } from "./entry-draft";
import {
	buildStartStopInstants,
	isTimeOfDay,
	minutesBetween,
	wallClockInZone,
} from "./zoned-time";

export type TimeSuggestion = Awaited<
	ReturnType<typeof orpcClient.timeTracking.listSuggestions>
>["suggestions"][number];

type SuggestionRun = Awaited<
	ReturnType<typeof orpcClient.timeTracking.suggestionStatus>
>;

export type ConfirmSuggestionFields = Parameters<
	typeof orpcClient.timeTracking.confirmSuggestion
>[0];

/** How often the page reads a generation run's status while it runs. */
const SUGGESTION_POLL_INTERVAL_MS = 2_000;

/** What a row holds while the person looks at it; sent only on confirm. */
export interface SuggestionDraft {
	durationText: string;
	startTime: string;
	stopTime: string;
	stopsNextDay: boolean;
	description: string;
	billable: boolean;
	activity: TimeActivity;
	story: StoryRef | null;
}

/** The suggestion came from one real span of time: it has a start and stop. */
function hasKnownInterval(suggestion: TimeSuggestion): boolean {
	return suggestion.startAt !== null && suggestion.stopAt !== null;
}

/** Minutes the suggestion proposes, from its duration or its span. */
function suggestedMinutes(suggestion: TimeSuggestion): number | null {
	if (suggestion.durationMinutes !== null) {
		return suggestion.durationMinutes;
	}
	if (suggestion.startAt !== null && suggestion.stopAt !== null) {
		return minutesBetween(suggestion.startAt, suggestion.stopAt);
	}
	return null;
}

/**
 * The values a row opens with. A row on a project that requires start and
 * stop asks for two times instead of a duration, filled in from the span the
 * suggestion came from when it has one.
 */
export function suggestionDraft(suggestion: TimeSuggestion): SuggestionDraft {
	const minutes = suggestedMinutes(suggestion);
	const start = suggestion.startAt
		? wallClockInZone(suggestion.startAt, suggestion.timezone)
		: null;
	const stop = suggestion.stopAt
		? wallClockInZone(suggestion.stopAt, suggestion.timezone)
		: null;
	return {
		durationText: minutes === null ? "" : formatDurationMinutes(minutes),
		startTime: start?.time ?? "",
		stopTime: stop?.time ?? "",
		stopsNextDay:
			stop !== null && stop.date === addDays(suggestion.workDate, 1),
		description: suggestion.description,
		billable: suggestion.billable ?? suggestion.defaultBillable,
		activity: suggestion.activity,
		story:
			suggestion.storyId &&
			suggestion.storyIdentifier &&
			suggestion.storyTitle
				? {
						id: suggestion.storyId,
						identifier: suggestion.storyIdentifier,
						title: suggestion.storyTitle,
					}
				: null,
	};
}

/** Minutes the row's start and stop add up to, or `null` if incomplete. */
export function draftIntervalMinutes(
	suggestion: TimeSuggestion,
	draft: SuggestionDraft,
): number | null {
	if (!isTimeOfDay(draft.startTime) || !isTimeOfDay(draft.stopTime)) {
		return null;
	}
	const instants = buildStartStopInstants({
		workDate: suggestion.workDate,
		startTime: draft.startTime,
		stopTime: draft.stopTime,
		stopsNextDay: draft.stopsNextDay,
		timeZone: suggestion.timezone,
	});
	return minutesBetween(instants.startAt, instants.stopAt);
}

type ConfirmFieldsResult =
	| { ok: true; fields: ConfirmSuggestionFields }
	| { ok: false; problem: DraftProblem };

/**
 * The request a row's Confirm sends.
 *
 * A typed duration is the approval and is sent as `durationMinutes`; left as
 * the span the suggestion came from, nothing is sent and the server keeps
 * that span's start and stop. A row that needs start and stop always sends
 * both. The rest of the row (activity, billable, note, work item) is sent as
 * shown, so what the person saw is what is saved.
 */
export function buildConfirmFields(
	suggestion: TimeSuggestion,
	draft: SuggestionDraft,
): ConfirmFieldsResult {
	const common = {
		suggestionId: suggestion.id,
		timezone: suggestion.timezone,
		activity: draft.activity,
		billable: draft.billable,
		description: draft.description.trim() || null,
		storyId: draft.story?.id ?? null,
		acknowledgedWarnings: [],
	};

	if (suggestion.startStopRequired) {
		if (!isTimeOfDay(draft.startTime) || !isTimeOfDay(draft.stopTime)) {
			return { ok: false, problem: "times" };
		}
		const instants = buildStartStopInstants({
			workDate: suggestion.workDate,
			startTime: draft.startTime,
			stopTime: draft.stopTime,
			stopsNextDay: draft.stopsNextDay,
			timeZone: suggestion.timezone,
		});
		const minutes = minutesBetween(instants.startAt, instants.stopAt);
		if (minutes === null) {
			return { ok: false, problem: "stopBeforeStart" };
		}
		if (!isValidDurationMinutes(minutes)) {
			return { ok: false, problem: "tooLong" };
		}
		return { ok: true, fields: { ...common, ...instants } };
	}

	const durationMinutes = parseDurationInput(draft.durationText);
	if (durationMinutes === null) {
		return { ok: false, problem: "duration" };
	}
	if (!isValidDurationMinutes(durationMinutes)) {
		return { ok: false, problem: "tooLong" };
	}
	if (
		hasKnownInterval(suggestion) &&
		durationMinutes === suggestedMinutes(suggestion)
	) {
		return { ok: true, fields: common };
	}
	return { ok: true, fields: { ...common, durationMinutes } };
}

/**
 * The rows "Confirm all with a known duration" takes, in list order: those
 * built from a real span of time. The batch is offered only for two or more.
 */
export function batchConfirmable(
	suggestions: readonly TimeSuggestion[],
): TimeSuggestion[] {
	const eligible = suggestions.filter(hasKnownInterval);
	return eligible.length >= 2 ? eligible : [];
}

/** Work dates that have at least one suggestion waiting. */
export function suggestedWorkDates(
	suggestions: readonly Pick<TimeSuggestion, "workDate">[],
): Set<string> {
	return new Set(suggestions.map((suggestion) => suggestion.workDate));
}

/** Poll while the newest run is still generating; stop on any end state. */
export function suggestionPollInterval(
	run: SuggestionRun | undefined,
): number | false {
	return run?.status === "GENERATING" ? SUGGESTION_POLL_INTERVAL_MS : false;
}

/**
 * The generation runs the page follows.
 *
 * A loud run is one the member asked for: "Check my activity" shows it
 * running, and how it ended is said. A quiet run is any other the page sees
 * generating: one Fabric started on its own, after a meeting or when My time
 * opened. When a quiet run ends the list reloads and nothing is said, so its
 * rows simply appear.
 */
export interface FollowedRuns {
	loudRunId: string | null;
	quietRunId: string | null;
}

/** How a followed run ended: a loud run's outcome, or `quiet`. */
type FollowedRunEnd = "failed" | "empty" | "found" | "quiet";

function loudOutcome(
	status: "DONE" | "FAILED",
	createdCount: number,
): "failed" | "empty" | "found" {
	switch (status) {
		case "FAILED":
			return "failed";
		case "DONE":
			return createdCount === 0 ? "empty" : "found";
		default: {
			const unhandled: never = status;
			throw new Error(`Unhandled run status: ${String(unhandled)}`);
		}
	}
}

/**
 * Follow the newest run as the status poll reports it. Returns the same
 * `followed` object when nothing changed, and `ended` once a followed run
 * has left GENERATING.
 *
 * A run generating that the page does not follow yet is quiet, unless a loud
 * run is still awaited: only one run generates at a time, so the new one
 * took over from it and inherits the wait.
 */
export function followRun(
	followed: FollowedRuns,
	run: SuggestionRun | undefined,
): { followed: FollowedRuns; ended: FollowedRunEnd | null } {
	if (!run) {
		return { followed, ended: null };
	}
	if (run.status === "GENERATING") {
		if (
			run.runId === followed.loudRunId ||
			run.runId === followed.quietRunId
		) {
			return { followed, ended: null };
		}
		return {
			followed:
				followed.loudRunId === null
					? { ...followed, quietRunId: run.runId }
					: { ...followed, loudRunId: run.runId },
			ended: null,
		};
	}
	if (run.runId === followed.loudRunId) {
		return {
			followed: {
				loudRunId: null,
				quietRunId:
					followed.quietRunId === run.runId
						? null
						: followed.quietRunId,
			},
			ended: loudOutcome(run.status, run.createdCount),
		};
	}
	if (run.runId === followed.quietRunId) {
		return { followed: { ...followed, quietRunId: null }, ended: "quiet" };
	}
	return { followed, ended: null };
}

/**
 * The wall-clock span the evidence covers in the suggestion's zone
 * (`09:10–11:40`), or one time when it is a single instant.
 */
export function evidenceTimeRange(
	evidence: TimeSuggestion["evidence"],
	timeZone: string,
): string | null {
	if (evidence.length === 0) {
		return null;
	}
	const earliest = evidence.reduce(
		(min, item) => (item.earliestAt < min ? item.earliestAt : min),
		evidence[0].earliestAt,
	);
	const latest = evidence.reduce(
		(max, item) => (item.latestAt > max ? item.latestAt : max),
		evidence[0].latestAt,
	);
	const from = wallClockInZone(earliest, timeZone).time;
	const to = wallClockInZone(latest, timeZone).time;
	return from === to ? from : `${from}–${to}`;
}
