/**
 * Pure rules of the running timer's widget: the time it shows, when it shows,
 * what Stop does first, when the reminder fires, and how an action from the
 * activity log is named in the forgotten-timer question.
 *
 * The server holds the timer. Everything here works from the last `get` (or
 * the last change's answer) and the moment it arrived, so a tab whose clock is
 * off shows the same time as every other tab.
 */

import { ORPCError } from "@orpc/client";
import {
	addDays,
	TIME_ACTIVITY_VALUES,
	type TimeActivity,
} from "@repo/utils/time-tracking";
import type { orpcClient } from "@shared/lib/orpc-client";
import type { StoryRef } from "./entry-draft";
import {
	isTimeOfDay,
	wallClockInZone,
	zonedWallClockToIso,
} from "./zoned-time";

type TimerState = Awaited<ReturnType<typeof orpcClient.timeTracking.timer.get>>;

export type TimerView = NonNullable<TimerState["timer"]>;

export type TimerPreference = TimerState["preference"];

type TimerProposal = Awaited<
	ReturnType<typeof orpcClient.timeTracking.timer.proposeStop>
>;

type TimerSegment = TimerView["segments"][number];

/** An open segment past this many seconds turns the dot amber. */
const LONG_RUN_SECONDS = 8 * 60 * 60;

/** An open segment past this many seconds is reminded about. */
const REMINDER_AFTER_SECONDS = 4 * 60 * 60;

/**
 * Below this, `proposeStop` cannot ask (it needs over 30 minutes since the
 * last action), so the reminder does not read it.
 */
const PROPOSAL_MIN_SECONDS = 30 * 60;

/** How many reminded timer ids a browser keeps. */
const REMINDED_TIMERS_KEPT = 20;

function closedSegmentSeconds(segments: readonly TimerSegment[]): number {
	const closedMs = segments.reduce(
		(sum, segment) =>
			segment.stopAt === null
				? sum
				: sum +
					Math.max(
						0,
						Date.parse(segment.stopAt) -
							Date.parse(segment.startAt),
					),
		0,
	);
	return Math.floor(closedMs / 1000);
}

/**
 * Whole seconds the timer has run at `nowMs`: what the server counted when
 * the timer arrived, plus the time since then while it runs.
 */
export function timerElapsedAt(
	timer: Pick<TimerView, "status" | "elapsedSeconds">,
	fetchedAtMs: number,
	nowMs: number,
): number {
	if (timer.status !== "RUNNING") {
		return timer.elapsedSeconds;
	}
	return (
		timer.elapsedSeconds +
		Math.max(0, Math.floor((nowMs - fetchedAtMs) / 1000))
	);
}

/** Seconds of the running segment at `nowMs`; `null` while paused. */
export function openSegmentSeconds(
	timer: Pick<TimerView, "status" | "elapsedSeconds" | "segments">,
	fetchedAtMs: number,
	nowMs: number,
): number | null {
	if (
		timer.status !== "RUNNING" ||
		!timer.segments.some((segment) => segment.stopAt === null)
	) {
		return null;
	}
	return Math.max(
		0,
		timerElapsedAt(timer, fetchedAtMs, nowMs) -
			closedSegmentSeconds(timer.segments),
	);
}

/** `h:mm:ss`, hours unpadded. */
export function formatElapsed(totalSeconds: number): string {
	const seconds = Math.max(0, Math.floor(totalSeconds));
	const hours = Math.floor(seconds / 3600);
	const minutes = Math.floor((seconds % 3600) / 60);
	const rest = seconds % 60;
	return `${hours}:${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
}

/** The `HH:MM` an instant shows in `timeZone`. */
export function clockLabel(instant: string, timeZone: string): string {
	return wallClockInZone(instant, timeZone).time;
}

/** The dot beside the time: one shape and colour per state. */
export type TimerDotState = "running" | "paused" | "long" | "saved";

export function timerDotState(
	timer: Pick<TimerView, "status" | "elapsedSeconds" | "segments">,
	fetchedAtMs: number,
	nowMs: number,
): Exclude<TimerDotState, "saved"> {
	if (timer.status === "PAUSED") {
		return "paused";
	}
	const open = openSegmentSeconds(timer, fetchedAtMs, nowMs);
	return open !== null && open >= LONG_RUN_SECONDS ? "long" : "running";
}

/** What the widget shows, if anything. */
type WidgetContent = "none" | "timer" | "saved";

/**
 * A running or paused timer shows while the widget is `SHOWN`; a timer
 * stopped in this browser shows its outcome until it is closed, unless the
 * widget is off. `revealed` is a request to open it from elsewhere (a start
 * button, the reminder), which shows it whatever the preference.
 */
export function widgetContent(params: {
	hasTimer: boolean;
	hasSaved: boolean;
	widget: TimerPreference["timerWidget"];
	revealed: boolean;
}): WidgetContent {
	if (params.hasTimer) {
		return params.widget === "SHOWN" || params.revealed ? "timer" : "none";
	}
	if (params.hasSaved) {
		return params.widget === "OFF" && !params.revealed ? "none" : "saved";
	}
	return "none";
}

/** What Stop does once `proposeStop` has answered. */
type StopStep =
	| { kind: "stopNow" }
	| {
			kind: "ask";
			proposedStopAt: string;
			source: TimerProposal["source"];
	  };

export function stopStep(
	proposal: Pick<
		TimerProposal,
		"needsQuestion" | "proposedStopAt" | "source"
	>,
): StopStep {
	return proposal.needsQuestion
		? {
				kind: "ask",
				proposedStopAt: proposal.proposedStopAt,
				source: proposal.source,
			}
		: { kind: "stopNow" };
}

/** The start of the running segment, the earliest a picked stop may be. */
export function openSegmentStart(
	timer: Pick<TimerView, "segments">,
): string | null {
	return (
		timer.segments.find((segment) => segment.stopAt === null)?.startAt ??
		null
	);
}

/**
 * The instant a picked `HH:MM` names: the latest one at or before now in
 * `timeZone`, so a timer left overnight can stop yesterday evening. `null`
 * when it is before the running segment started. A pick in the minute the
 * segment started stops at its start.
 */
export function pickedStopAt(params: {
	time: string;
	openStartAt: string;
	nowMs: number;
	timeZone: string;
}): string | null {
	if (!isTimeOfDay(params.time)) {
		return null;
	}
	const today = wallClockInZone(
		new Date(params.nowMs).toISOString(),
		params.timeZone,
	).date;
	let picked = zonedWallClockToIso({
		date: today,
		time: params.time,
		timeZone: params.timeZone,
	});
	if (Date.parse(picked) > params.nowMs) {
		picked = zonedWallClockToIso({
			date: addDays(today, -1),
			time: params.time,
			timeZone: params.timeZone,
		});
	}
	const startMs = Date.parse(params.openStartAt);
	const pickedMs = Date.parse(picked);
	if (pickedMs >= startMs) {
		return picked;
	}
	return startMs - pickedMs < 60_000 ? params.openStartAt : null;
}

/**
 * Whether the reminder should fire now: reminders on, the timer running and
 * not reminded about before in this browser, and its running segment past
 * four hours or the stop question due.
 */
export function reminderDue(params: {
	status: TimerView["status"];
	remindersOn: boolean;
	alreadyReminded: boolean;
	openSeconds: number | null;
	stopQuestionDue: boolean;
}): boolean {
	if (
		params.status !== "RUNNING" ||
		!params.remindersOn ||
		params.alreadyReminded ||
		params.openSeconds === null
	) {
		return false;
	}
	return (
		params.openSeconds >= REMINDER_AFTER_SECONDS || params.stopQuestionDue
	);
}

/**
 * How often a tab rereads the timer, or `false` for not at all. A hidden tab
 * keeps rereading only while reminders are on, since the reminder is decided
 * on each reread and is meant for exactly the moment the user is elsewhere.
 */
export function timerRefetchInterval(params: {
	hasTimer: boolean;
	remindersOn: boolean;
	tabVisible: boolean;
	intervalMs: number;
}): number | false {
	if (!params.hasTimer) {
		return false;
	}
	return params.tabVisible || params.remindersOn ? params.intervalMs : false;
}

/**
 * Whether reading `proposeStop` could make the reminder due: the segment
 * must have run long enough for the question to be possible, and not so long
 * that the reminder is already due without it.
 */
export function reminderNeedsProposal(openSeconds: number | null): boolean {
	return (
		openSeconds !== null &&
		openSeconds >= PROPOSAL_MIN_SECONDS &&
		openSeconds < REMINDER_AFTER_SECONDS
	);
}

/** The reminded ids with `timerId` added, newest last, the oldest dropped. */
export function addRemindedTimer(
	reminded: readonly string[],
	timerId: string,
): string[] {
	return [...reminded.filter((id) => id !== timerId), timerId].slice(
		-REMINDED_TIMERS_KEPT,
	);
}

/** The reminded ids a browser stored, ignoring anything malformed. */
export function parseRemindedTimers(raw: string | null): string[] {
	if (!raw) {
		return [];
	}
	try {
		const parsed: unknown = JSON.parse(raw);
		return Array.isArray(parsed)
			? parsed.filter((id): id is string => typeof id === "string")
			: [];
	} catch {
		return [];
	}
}

/** What the person did, in words the question can use. */
type ActivityVerb = "created" | "edited" | "deleted" | "worked";

type ActivityObject =
	| "testCase"
	| "todo"
	| "comment"
	| "workItem"
	| "document"
	| "agent"
	| "workflow"
	| "meeting"
	| "time"
	| "project";

/** First match wins, so the narrower areas come before the wider ones. */
const ACTIVITY_OBJECTS: ReadonlyArray<[needle: string, ActivityObject]> = [
	["testcase", "testCase"],
	["todo", "todo"],
	["comment", "comment"],
	["stor", "workItem"],
	["document", "document"],
	["agent", "agent"],
	["workflow", "workflow"],
	["meeting", "meeting"],
	["timetracking", "time"],
	["project", "project"],
];

/** First match wins, like the areas. */
const ACTIVITY_VERBS: ReadonlyArray<[prefixes: string[], ActivityVerb]> = [
	// Opening My time checks for suggestions; that creates nothing.
	[["generatesuggestions"], "worked"],
	[["create", "add", "generate", "upload", "import"], "created"],
	[
		["update", "edit", "save", "set", "rename", "move", "reorder", "apply"],
		"edited",
	],
	[["delete", "remove", "archive", "discard"], "deleted"],
];

const ACTIVITY_PREFIX = "activity.";

/**
 * A short reading of an `activity.<router path>` audit action, such as
 * `activity.projects.stories.update` → edited a work item. `null` when the
 * action names no area the question can describe; the question then says
 * "your last action".
 */
export function describeActivityAction(
	action: string,
): { verb: ActivityVerb; object: ActivityObject } | null {
	if (!action.startsWith(ACTIVITY_PREFIX)) {
		return null;
	}
	const segments = action.slice(ACTIVITY_PREFIX.length).split(".");
	const path = segments.join(".").toLowerCase();
	const object = ACTIVITY_OBJECTS.find(([needle]) =>
		path.includes(needle),
	)?.[1];
	if (!object) {
		return null;
	}
	const procedure = (segments[segments.length - 1] ?? "").toLowerCase();
	const verb =
		ACTIVITY_VERBS.find(([prefixes]) =>
			prefixes.some((prefix) => procedure.startsWith(prefix)),
		)?.[1] ?? "worked";
	return { verb, object };
}

/** A timer stopped and saved in this browser, until its widget is closed. */
export interface SavedTimer {
	organizationId: string;
	timerId: string;
	projectId: string;
	projectName: string;
	activity: TimeActivity;
	story: StoryRef | null;
	entryIds: string[];
	totalMinutes: number;
	workDate: string;
}

export function savedTimerFrom(params: {
	organizationId: string;
	timer: Pick<
		TimerView,
		| "id"
		| "projectId"
		| "projectName"
		| "activity"
		| "storyId"
		| "storyIdentifier"
		| "storyTitle"
	>;
	entries: ReadonlyArray<{
		id: string;
		durationMinutes: number;
		workDate: string;
	}>;
}): SavedTimer {
	const { timer } = params;
	return {
		organizationId: params.organizationId,
		timerId: timer.id,
		projectId: timer.projectId,
		projectName: timer.projectName,
		activity: timer.activity,
		story:
			timer.storyId && timer.storyIdentifier
				? {
						id: timer.storyId,
						identifier: timer.storyIdentifier,
						title: timer.storyTitle ?? "",
					}
				: null,
		entryIds: params.entries.map((entry) => entry.id),
		totalMinutes: params.entries.reduce(
			(sum, entry) => sum + entry.durationMinutes,
			0,
		),
		workDate: params.entries[0]?.workDate ?? "",
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isStoryRef(value: unknown): value is StoryRef {
	return (
		isRecord(value) &&
		typeof value.id === "string" &&
		typeof value.identifier === "string" &&
		typeof value.title === "string"
	);
}

function isTimeActivity(value: unknown): value is TimeActivity {
	return TIME_ACTIVITY_VALUES.some((activity) => activity === value);
}

/** A saved timer read back from storage, or `null` when it is not one. */
export function parseSavedTimer(raw: string | null): SavedTimer | null {
	if (!raw) {
		return null;
	}
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		return null;
	}
	if (
		!isRecord(value) ||
		typeof value.organizationId !== "string" ||
		typeof value.timerId !== "string" ||
		typeof value.projectId !== "string" ||
		typeof value.projectName !== "string" ||
		!isTimeActivity(value.activity) ||
		!(value.story === null || isStoryRef(value.story)) ||
		!Array.isArray(value.entryIds) ||
		typeof value.totalMinutes !== "number" ||
		typeof value.workDate !== "string"
	) {
		return null;
	}
	return {
		organizationId: value.organizationId,
		timerId: value.timerId,
		projectId: value.projectId,
		projectName: value.projectName,
		activity: value.activity,
		story: value.story,
		entryIds: value.entryIds.filter(
			(id): id is string => typeof id === "string",
		),
		totalMinutes: value.totalMinutes,
		workDate: value.workDate,
	};
}

function isTimerView(value: unknown): value is TimerView {
	return (
		isRecord(value) &&
		typeof value.id === "string" &&
		typeof value.version === "number" &&
		typeof value.projectId === "string" &&
		typeof value.elapsedSeconds === "number" &&
		(value.status === "RUNNING" || value.status === "PAUSED") &&
		Array.isArray(value.segments)
	);
}

/**
 * The caller's current timer a CONFLICT carries in `data.timer` (a change
 * from a stale view, or a start while one runs); `null` for any other error.
 */
export function conflictTimer(error: unknown): TimerView | null {
	if (!(error instanceof ORPCError) || error.code !== "CONFLICT") {
		return null;
	}
	const data: unknown = error.data;
	return isRecord(data) && isTimerView(data.timer) ? data.timer : null;
}
