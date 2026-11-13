/**
 * Time suggestions: how a member's own activity becomes blocks of time Fabric
 * suggests they log. Shared by the worker that builds the suggestions and the
 * API that lists and confirms them.
 *
 * Kept free of imports beyond `./time-tracking`, so it needs no database
 * client and is safe in the browser bundle. Evidence kinds are plain string
 * literals that match the `TimeEvidenceKind` enum in the Prisma schema.
 *
 * A duration only ever comes from evidence that carries a time span: a meeting
 * the member had the meeting agent join. A suggestion built only from single
 * instants (an edit, a recorded result, a pull request push, a test run they
 * started, whose length is the machine's runtime) has no duration, and the
 * member enters one.
 * Nothing here estimates time from a count of edits.
 */

import {
	addDays,
	MAX_TIME_ENTRY_MINUTES,
	type ProjectBillingModel,
	TIME_ACTIVITY_LABELS,
	type TimeActivity,
	weekRange,
} from "./time-tracking";

/** Matches the `TimeEvidenceKind` enum in the Prisma schema. */
export const TIME_EVIDENCE_KIND_VALUES = [
	"MEETING_SESSION",
	"TEST_RUN",
	"FEATURE_EDIT",
	"TEST_RESULT",
	"TEST_CASE_ACTIVITY",
	"PULL_REQUEST",
] as const;

export type TimeEvidenceKind = (typeof TIME_EVIDENCE_KIND_VALUES)[number];

/** The widest work-date range one generation may read, inclusive. */
export const MAX_TIME_SUGGESTION_SPAN_DAYS = 14;

/** The range a generation reads when none is given: the week ending today. */
export const DEFAULT_TIME_SUGGESTION_SPAN_DAYS = 7;

/** The longest description a suggestion is stored with. */
export const MAX_TIME_SUGGESTION_DESCRIPTION_LENGTH = 200;

/**
 * Whether Fabric builds suggestions for a project without being asked: after
 * a member's own meeting on it ends, and when they open My time.
 *
 * A time and materials project bills its hours, so its list fills by itself.
 * A fixed bid project gets suggestions only when the member asks with "Check
 * my activity". The single place that decides it, for every automatic start.
 */
export function suggestsTimeAutomatically(
	billingModel: ProjectBillingModel,
): boolean {
	switch (billingModel) {
		case "TIME_AND_MATERIALS":
			return true;
		case "FIXED_BID":
			return false;
		default: {
			const unhandled: never = billingModel;
			throw new Error(`Unhandled billing model: ${String(unhandled)}`);
		}
	}
}

// ---------------------------------------------------------------------------
// Dates in a time zone
// ---------------------------------------------------------------------------

function zonedParts(instant: Date, timeZone: string) {
	const parts = new Intl.DateTimeFormat("en-CA", {
		timeZone,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		hourCycle: "h23",
	}).formatToParts(instant);
	const part = (type: Intl.DateTimeFormatPartTypes) =>
		parts.find((p) => p.type === type)?.value ?? "00";
	return {
		date: `${part("year")}-${part("month")}-${part("day")}`,
		hour: part("hour"),
		minute: part("minute"),
		second: part("second"),
	};
}

/** The `YYYY-MM-DD` date an instant falls on in `timeZone`. */
export function localDateOf(instant: Date, timeZone: string): string {
	return zonedParts(instant, timeZone).date;
}

/** `09:30`: the wall-clock time of an instant in `timeZone`. */
export function localTimeOf(instant: Date, timeZone: string): string {
	const { hour, minute } = zonedParts(instant, timeZone);
	return `${hour}:${minute}`;
}

/** How far `timeZone` is ahead of UTC at `instant`, in milliseconds. */
function zoneOffsetMs(instant: Date, timeZone: string): number {
	const { date, hour, minute, second } = zonedParts(instant, timeZone);
	const wallClockAsUtc = Date.parse(
		`${date}T${hour}:${minute}:${second}.000Z`,
	);
	const wholeSeconds = instant.getTime() - instant.getUTCMilliseconds();
	return wallClockAsUtc - wholeSeconds;
}

/**
 * The instant `date` begins in `timeZone`.
 *
 * The offset is read twice, the second time at the first guess, so a day
 * that starts on the other side of a daylight-saving change than the UTC
 * midnight before it still lands on its own midnight. Where a zone skips
 * midnight itself, the day begins at the change, which is the first guess.
 */
export function zonedMidnight(date: string, timeZone: string): Date {
	const utcMidnight = Date.parse(`${date}T00:00:00.000Z`);
	const firstGuess =
		utcMidnight - zoneOffsetMs(new Date(utcMidnight), timeZone);
	const secondGuess =
		utcMidnight - zoneOffsetMs(new Date(firstGuess), timeZone);
	if (localDateOf(new Date(secondGuess), timeZone) === date) {
		return new Date(secondGuess);
	}
	return new Date(firstGuess);
}

/**
 * When a suggestion for `workDate` stops being offered: the end of the Sunday
 * of the week after it (weeks run Monday to Sunday), in `timeZone`. A week of
 * grace after the week the work happened in, so a member who confirms their
 * time on Monday morning still sees last week's suggestions.
 */
export function timeSuggestionExpiry(workDate: string, timeZone: string): Date {
	const { to: sunday } = weekRange(workDate);
	return zonedMidnight(addDays(sunday, 8), timeZone);
}

// ---------------------------------------------------------------------------
// Intervals
// ---------------------------------------------------------------------------

export interface TimeInterval {
	startAt: Date;
	endAt: Date;
}

/** Overlapping and touching intervals joined, earliest first. */
export function mergeIntervals(
	intervals: readonly TimeInterval[],
): TimeInterval[] {
	const sorted = intervals
		.filter((interval) => interval.endAt > interval.startAt)
		.sort((a, b) => a.startAt.getTime() - b.startAt.getTime());
	const merged: TimeInterval[] = [];
	for (const interval of sorted) {
		const last = merged.at(-1);
		if (last && interval.startAt <= last.endAt) {
			if (interval.endAt > last.endAt) {
				last.endAt = interval.endAt;
			}
			continue;
		}
		merged.push({ startAt: interval.startAt, endAt: interval.endAt });
	}
	return merged;
}

/** The parts of `base` that no interval of `minus` covers, earliest first. */
export function subtractIntervals(
	base: readonly TimeInterval[],
	minus: readonly TimeInterval[],
): TimeInterval[] {
	const cuts = mergeIntervals(minus);
	const remaining: TimeInterval[] = [];
	for (const interval of mergeIntervals(base)) {
		let cursor = interval.startAt;
		for (const cut of cuts) {
			if (cut.endAt <= cursor || cut.startAt >= interval.endAt) {
				continue;
			}
			if (cut.startAt > cursor) {
				remaining.push({ startAt: cursor, endAt: cut.startAt });
			}
			if (cut.endAt > cursor) {
				cursor = cut.endAt;
			}
		}
		if (cursor < interval.endAt) {
			remaining.push({ startAt: cursor, endAt: interval.endAt });
		}
	}
	return remaining;
}

function clipInterval(
	interval: TimeInterval,
	bounds: TimeInterval,
): TimeInterval | null {
	const startAt =
		interval.startAt > bounds.startAt ? interval.startAt : bounds.startAt;
	const endAt = interval.endAt < bounds.endAt ? interval.endAt : bounds.endAt;
	return endAt > startAt ? { startAt, endAt } : null;
}

function totalMinutes(intervals: readonly TimeInterval[]): number {
	const ms = intervals.reduce(
		(sum, interval) =>
			sum + (interval.endAt.getTime() - interval.startAt.getTime()),
		0,
	);
	return Math.round(ms / 60_000);
}

// ---------------------------------------------------------------------------
// Grouping
// ---------------------------------------------------------------------------

/** The activity a kind of evidence suggests before anyone refines it. */
export function activityForEvidenceKind(kind: TimeEvidenceKind): TimeActivity {
	switch (kind) {
		case "MEETING_SESSION":
			return "MEETINGS_COLLABORATION";
		case "TEST_RUN":
		case "TEST_RESULT":
		case "TEST_CASE_ACTIVITY":
			return "TESTING";
		case "FEATURE_EDIT":
			return "PLANNING_REQUIREMENTS";
		case "PULL_REQUEST":
			return "DEVELOPMENT";
		default: {
			const unreachable: never = kind;
			throw new Error(`Unhandled evidence kind: ${String(unreachable)}`);
		}
	}
}

/** One piece of a member's own activity, as the collectors read it. */
export interface TimeEvidence {
	kind: TimeEvidenceKind;
	/** The id of the row it was read from. */
	sourceId: string;
	projectId: string;
	storyId: string | null;
	/** When it happened; the start, for evidence with a span. */
	occurredAt: Date;
	/** Both set for evidence with a span, both null for an instant. */
	startAt: Date | null;
	endAt: Date | null;
}

/** The evidence one suggestion is built from, with its time. */
export interface TimeEvidenceGroup {
	workDate: string;
	projectId: string;
	storyId: string | null;
	activity: TimeActivity;
	evidence: TimeEvidence[];
	/** Null when no evidence carried a span, or none of it is left to log. */
	durationMinutes: number | null;
	/** Set only when what is left is one unbroken span. */
	startAt: Date | null;
	stopAt: Date | null;
}

/** Where one of the member's confirmed entries puts its time. */
export interface LoggedTimeEntry {
	projectId: string;
	workDate: string;
	storyId: string | null;
}

/**
 * Whether a confirmed entry already accounts for a group's day: one on the
 * same project and work date, on the group's work item or on no work item (a
 * general entry covers the whole project's day).
 */
function representedByEntry(
	group: Pick<TimeEvidenceGroup, "workDate" | "projectId" | "storyId">,
	entries: readonly LoggedTimeEntry[],
): boolean {
	return entries.some(
		(entry) =>
			entry.projectId === group.projectId &&
			entry.workDate === group.workDate &&
			(entry.storyId === null || entry.storyId === group.storyId),
	);
}

function evidenceSpan(evidence: TimeEvidence): TimeInterval | null {
	if (!evidence.startAt || !evidence.endAt) {
		return null;
	}
	return evidence.endAt > evidence.startAt
		? { startAt: evidence.startAt, endAt: evidence.endAt }
		: null;
}

/**
 * The member's new evidence as one group per work date, project, work item
 * and activity, each with the time it supports.
 *
 * The work date is the date the evidence happened on (a span: the date it
 * started on) in `timeZone`. A group's time is its spans clipped to that
 * date, merged, minus every span the member has already logged
 * (`loggedIntervals`, the start and stop of their confirmed entries). When
 * one unbroken span is left the group carries its start and stop; when
 * several are, only their total.
 *
 * A group made only of spans that are already logged is dropped: there is
 * nothing left to suggest. A group with instants as well is kept without a
 * duration, because the instants still say the member worked that day,
 * unless a confirmed entry already accounts for that day (`loggedEntries`:
 * one on the same project and work date, on the group's work item or on no
 * work item). Instants have no position in the day, so that entry is what
 * represents them, whether it was saved with times or a duration only.
 */
export function groupTimeEvidence(params: {
	evidence: readonly TimeEvidence[];
	timeZone: string;
	loggedIntervals: readonly TimeInterval[];
	loggedEntries: readonly LoggedTimeEntry[];
}): TimeEvidenceGroup[] {
	const groups = new Map<
		string,
		Pick<
			TimeEvidenceGroup,
			"workDate" | "projectId" | "storyId" | "activity"
		> & {
			evidence: TimeEvidence[];
		}
	>();
	for (const evidence of params.evidence) {
		const workDate = localDateOf(evidence.occurredAt, params.timeZone);
		const activity = activityForEvidenceKind(evidence.kind);
		const key = [
			workDate,
			evidence.projectId,
			evidence.storyId ?? "",
			activity,
		].join("|");
		const group = groups.get(key);
		if (group) {
			group.evidence.push(evidence);
		} else {
			groups.set(key, {
				workDate,
				projectId: evidence.projectId,
				storyId: evidence.storyId,
				activity,
				evidence: [evidence],
			});
		}
	}

	const logged = mergeIntervals(params.loggedIntervals);
	const result: TimeEvidenceGroup[] = [];
	for (const group of groups.values()) {
		const day: TimeInterval = {
			startAt: zonedMidnight(group.workDate, params.timeZone),
			endAt: zonedMidnight(addDays(group.workDate, 1), params.timeZone),
		};
		const spans = group.evidence
			.map(evidenceSpan)
			.filter((span): span is TimeInterval => span !== null);
		const clipped = spans
			.map((span) => clipInterval(span, day))
			.filter((span): span is TimeInterval => span !== null);
		const remaining = subtractIntervals(clipped, logged);
		const minutes = totalMinutes(remaining);
		const onlySpans = spans.length === group.evidence.length;

		if (minutes === 0) {
			if (onlySpans || representedByEntry(group, params.loggedEntries)) {
				continue;
			}
			result.push({
				...group,
				durationMinutes: null,
				startAt: null,
				stopAt: null,
			});
			continue;
		}

		const single = remaining.length === 1 ? remaining[0] : null;
		const fitsOneEntry = minutes <= MAX_TIME_ENTRY_MINUTES;
		result.push({
			...group,
			durationMinutes: Math.min(minutes, MAX_TIME_ENTRY_MINUTES),
			startAt: single && fitsOneEntry ? single.startAt : null,
			stopAt: single && fitsOneEntry ? single.endAt : null,
		});
	}

	return result.sort(
		(a, b) =>
			a.workDate.localeCompare(b.workDate) ||
			a.projectId.localeCompare(b.projectId) ||
			(a.storyId ?? "").localeCompare(b.storyId ?? "") ||
			a.activity.localeCompare(b.activity),
	);
}

// ---------------------------------------------------------------------------
// Summaries and wording
// ---------------------------------------------------------------------------

/** How much evidence of one kind a suggestion holds, and when. */
export interface TimeEvidenceSummary {
	kind: TimeEvidenceKind;
	count: number;
	earliestAt: Date;
	latestAt: Date;
}

/** Evidence counted per kind, in {@link TIME_EVIDENCE_KIND_VALUES} order. */
export function summarizeTimeEvidence(
	evidence: readonly {
		kind: TimeEvidenceKind;
		occurredAt: Date;
		endAt: Date | null;
	}[],
): TimeEvidenceSummary[] {
	const summaries: TimeEvidenceSummary[] = [];
	for (const kind of TIME_EVIDENCE_KIND_VALUES) {
		const ofKind = evidence.filter((item) => item.kind === kind);
		if (ofKind.length === 0) {
			continue;
		}
		const starts = ofKind.map((item) => item.occurredAt.getTime());
		const ends = ofKind.map((item) =>
			(item.endAt ?? item.occurredAt).getTime(),
		);
		summaries.push({
			kind,
			count: ofKind.length,
			earliestAt: new Date(Math.min(...starts)),
			latestAt: new Date(Math.max(...ends)),
		});
	}
	return summaries;
}

const EVIDENCE_NOUNS: Readonly<
	Record<TimeEvidenceKind, { one: string; many: string }>
> = {
	MEETING_SESSION: { one: "meeting", many: "meetings" },
	TEST_RUN: { one: "test run", many: "test runs" },
	FEATURE_EDIT: { one: "work item edit", many: "work item edits" },
	TEST_RESULT: { one: "recorded test result", many: "recorded test results" },
	TEST_CASE_ACTIVITY: { one: "test case change", many: "test case changes" },
	PULL_REQUEST: { one: "pull request push", many: "pull request pushes" },
};

/** `3 recorded test results`. */
export function describeEvidenceCount(
	kind: TimeEvidenceKind,
	count: number,
): string {
	const noun = EVIDENCE_NOUNS[kind];
	return `${count} ${count === 1 ? noun.one : noun.many}`;
}

function joinWithAnd(items: readonly string[]): string {
	if (items.length <= 1) {
		return items.join("");
	}
	return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

function evidenceList(summaries: readonly TimeEvidenceSummary[]): string {
	return joinWithAnd(
		summaries.map((summary) =>
			describeEvidenceCount(summary.kind, summary.count),
		),
	);
}

/** The one line a suggestion shows to say what it was built from. */
export function timeSuggestionExplanation(
	summaries: readonly TimeEvidenceSummary[],
): string {
	return `Suggested from ${evidenceList(summaries)}.`;
}

/** A stored description: one plain line, trimmed to the stored length. */
export function normalizeSuggestionDescription(text: string): string | null {
	const line = text.replace(/\s+/g, " ").trim();
	if (line === "") {
		return null;
	}
	return line.slice(0, MAX_TIME_SUGGESTION_DESCRIPTION_LENGTH).trimEnd();
}

/**
 * The description a suggestion gets when no model wrote one: the activity,
 * and the work item or else the evidence it came from.
 */
export function fallbackTimeSuggestionDescription(params: {
	activity: TimeActivity;
	storyIdentifier: string | null;
	storyTitle: string | null;
	summaries: readonly TimeEvidenceSummary[];
}): string {
	const label = TIME_ACTIVITY_LABELS[params.activity];
	const workItem = [params.storyIdentifier, params.storyTitle]
		.filter((text): text is string => Boolean(text))
		.join(" ");
	const text =
		workItem === ""
			? `${label}: ${evidenceList(params.summaries)}`
			: `${label} on ${workItem}`;
	return normalizeSuggestionDescription(text) ?? label;
}
