/**
 * The entry form's values and the save request built from them.
 *
 * The form keeps what the person typed (`durationText`, `startTime`, …) and
 * turns it into the API's fields only on save, so a half-typed value is never
 * lost to a parse.
 */

import {
	addDays,
	formatDurationMinutes,
	isValidDurationMinutes,
	parseDurationInput,
	type TimeActivity,
	type TimeEntryWarning,
	type TimeWarningCode,
} from "@repo/utils/time-tracking";
import type { orpcClient } from "@shared/lib/orpc-client";
import type { TimeEntry } from "./time-entry-model";
import {
	buildStartStopInstants,
	isTimeOfDay,
	minutesBetween,
	wallClockInZone,
} from "./zoned-time";

export type TimeEntryFields = Parameters<
	typeof orpcClient.timeTracking.createEntry
>[0];

export interface StoryRef {
	id: string;
	identifier: string;
	title: string;
}

export interface EntryDraft {
	projectId: string | null;
	activity: TimeActivity;
	story: StoryRef | null;
	workDate: string;
	durationText: string;
	startTime: string;
	stopTime: string;
	stopsNextDay: boolean;
	description: string;
	/** `null` leaves it to the project's default (create) or keeps it (edit). */
	billable: boolean | null;
	timezone: string;
}

/** What an entry is on, without its time: the values a timer starts from. */
export type EntrySelection = Pick<
	EntryDraft,
	"projectId" | "activity" | "story"
>;

export function emptyDraft(params: {
	projectId: string | null;
	activity: TimeActivity;
	story?: StoryRef | null;
	workDate: string;
	timezone: string;
}): EntryDraft {
	return {
		projectId: params.projectId,
		activity: params.activity,
		story: params.story ?? null,
		workDate: params.workDate,
		durationText: "",
		startTime: "",
		stopTime: "",
		stopsNextDay: false,
		description: "",
		billable: null,
		timezone: params.timezone,
	};
}

/** The form values an existing entry opens with. */
export function draftFromEntry(entry: TimeEntry): EntryDraft {
	const start = entry.startAt
		? wallClockInZone(entry.startAt, entry.timezone)
		: null;
	const stop = entry.stopAt
		? wallClockInZone(entry.stopAt, entry.timezone)
		: null;
	return {
		projectId: entry.projectId,
		activity: entry.activity,
		story:
			entry.storyId && entry.storyIdentifier && entry.storyTitle
				? {
						id: entry.storyId,
						identifier: entry.storyIdentifier,
						title: entry.storyTitle,
					}
				: null,
		workDate: entry.workDate,
		durationText: start ? "" : formatDurationMinutes(entry.durationMinutes),
		startTime: start?.time ?? "",
		stopTime: stop?.time ?? "",
		stopsNextDay: stop !== null && stop.date === addDays(entry.workDate, 1),
		description: entry.description ?? "",
		billable: entry.billable,
		timezone: entry.timezone,
	};
}

export type DraftProblem =
	| "project"
	| "duration"
	| "times"
	| "stopBeforeStart"
	| "tooLong";

/** The `timeTracking.form` message that explains each problem. */
export const DRAFT_PROBLEM_KEYS: Readonly<Record<DraftProblem, string>> = {
	project: "problems.project",
	duration: "problems.duration",
	times: "problems.times",
	stopBeforeStart: "problems.stopBeforeStart",
	tooLong: "problems.tooLong",
};

type DraftResult =
	| { ok: true; fields: TimeEntryFields }
	| { ok: false; problem: DraftProblem };

/** Minutes the start/stop line currently adds up to, or `null` if incomplete. */
export function draftTimedMinutes(draft: EntryDraft): number | null {
	if (!isTimeOfDay(draft.startTime) || !isTimeOfDay(draft.stopTime)) {
		return null;
	}
	const { startAt, stopAt } = buildStartStopInstants({
		workDate: draft.workDate,
		startTime: draft.startTime,
		stopTime: draft.stopTime,
		stopsNextDay: draft.stopsNextDay,
		timeZone: draft.timezone,
	});
	return minutesBetween(startAt, stopAt);
}

/**
 * The request a save sends. `timed` says whether the entry is saved with a
 * start and stop (the project or the entry requires it) or with a duration.
 */
export function buildEntryFields(
	draft: EntryDraft,
	options: { timed: boolean; acknowledgedWarnings: TimeWarningCode[] },
): DraftResult {
	if (!draft.projectId) {
		return { ok: false, problem: "project" };
	}
	const common = {
		projectId: draft.projectId,
		workDate: draft.workDate,
		timezone: draft.timezone,
		activity: draft.activity,
		description: draft.description.trim() || null,
		storyId: draft.story?.id ?? null,
		acknowledgedWarnings: options.acknowledgedWarnings,
		...(draft.billable === null ? {} : { billable: draft.billable }),
	};

	if (options.timed) {
		if (!isTimeOfDay(draft.startTime) || !isTimeOfDay(draft.stopTime)) {
			return { ok: false, problem: "times" };
		}
		const instants = buildStartStopInstants({
			workDate: draft.workDate,
			startTime: draft.startTime,
			stopTime: draft.stopTime,
			stopsNextDay: draft.stopsNextDay,
			timeZone: draft.timezone,
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
	return { ok: true, fields: { ...common, durationMinutes } };
}

/** The first warning the person has not answered yet, if any. */
export function nextUnansweredWarning(
	warnings: readonly TimeEntryWarning[],
	acknowledged: readonly TimeWarningCode[],
): TimeEntryWarning | null {
	return (
		warnings.find((warning) => !acknowledged.includes(warning.code)) ?? null
	);
}
