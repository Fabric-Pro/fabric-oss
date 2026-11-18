/**
 * Calendar meetings as time evidence: which of a member's own Teams meetings
 * count, and what evidence each becomes. Pure; the collect activity reads the
 * calendar and the database and passes the rows in.
 *
 * A meeting counts when it is not cancelled, not all-day and not shown as
 * free; the member organized it, accepted it or marked it tentative; it
 * started in the run's window and lasts more than nothing and at most one
 * entry; and its join URL is the series linked to exactly one of the member's
 * projects. A meeting whose URL is linked to no project, or to several, is
 * skipped: Fabric would have to guess the project.
 *
 * Each counted meeting becomes, in this order:
 *  - the agent's own join of that occurrence (an AUTO session), from its join
 *    to its end, when there is one. The member is credited because their
 *    calendar shows they accepted, whoever enabled automatic joining;
 *  - nothing, when the member had the agent join that meeting themselves (a
 *    MANUAL session): that session is already evidence, with real times;
 *  - otherwise a CALENDAR_EVENT from the meeting's start to its end.
 *
 * Nothing of the meeting but a SHA-256 of its calendar event id, its project
 * and its times leaves here: the result is recorded in the workflow history.
 */

import { createHash } from "node:crypto";
import type { CollectedTimeEvidence } from "@repo/database";
import type { CalendarTimeEvidenceEvent } from "@repo/integrations/microsoft";
import { MAX_TIME_ENTRY_MINUTES } from "@repo/utils/time-tracking";

/**
 * How far a session's occurrence start or join may be from the calendar
 * meeting's start and still be that meeting. Automatic joining records the
 * calendar start itself as the occurrence; the minute absorbs rounding.
 */
export const CALENDAR_OCCURRENCE_TOLERANCE_MS = 60_000;

/** The responses that mean the member planned to be there. */
const ATTENDING_RESPONSES: ReadonlySet<string> = new Set([
	"organizer",
	"accepted",
	"tentativelyAccepted",
]);

export interface CalendarLinkedMeeting {
	id: string;
	projectId: string;
	joinUrl: string;
}

export interface CalendarAutoJoinSession {
	id: string;
	projectId: string;
	linkedMeetingId: string | null;
	occurrenceStart: Date | null;
	joinedAt: Date | null;
	endedAt: Date | null;
}

export interface CalendarManualSession {
	projectId: string;
	joinedAt: Date | null;
}

/** A calendar meeting that counts, with the one series it belongs to. */
export interface QualifiedCalendarMeeting {
	eventId: string;
	linkedMeetingId: string;
	projectId: string;
	startAt: Date;
	endAt: Date;
}

const normalizeJoinUrl = (url: string) => url.trim().toLowerCase();

function instant(value: string | null): Date | null {
	if (!value) {
		return null;
	}
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? null : date;
}

function attends(event: CalendarTimeEvidenceEvent): boolean {
	return (
		event.isOrganizer ||
		(event.response !== null && ATTENDING_RESPONSES.has(event.response))
	);
}

/** The member's calendar meetings that count, each on its one linked series. */
export function qualifyCalendarMeetings(input: {
	events: readonly CalendarTimeEvidenceEvent[];
	linkedMeetings: readonly CalendarLinkedMeeting[];
	from: Date;
	to: Date;
}): QualifiedCalendarMeeting[] {
	const seriesByUrl = new Map<string, CalendarLinkedMeeting[]>();
	for (const series of input.linkedMeetings) {
		const key = normalizeJoinUrl(series.joinUrl);
		seriesByUrl.set(key, [...(seriesByUrl.get(key) ?? []), series]);
	}

	const meetings: QualifiedCalendarMeeting[] = [];
	for (const event of input.events) {
		if (
			event.isCancelled ||
			event.isAllDay ||
			event.showAs === "free" ||
			!attends(event)
		) {
			continue;
		}
		const startAt = instant(event.startAt);
		const endAt = instant(event.endAt);
		if (!startAt || !endAt || startAt < input.from || startAt >= input.to) {
			continue;
		}
		const minutes = (endAt.getTime() - startAt.getTime()) / 60_000;
		if (minutes <= 0 || minutes > MAX_TIME_ENTRY_MINUTES) {
			continue;
		}
		const series = seriesByUrl.get(normalizeJoinUrl(event.joinUrl)) ?? [];
		if (series.length !== 1) {
			continue;
		}
		meetings.push({
			eventId: event.id,
			linkedMeetingId: series[0].id,
			projectId: series[0].projectId,
			startAt,
			endAt,
		});
	}
	return meetings;
}

/** The source id a calendar meeting is stored under, never its event id. */
export function calendarEventSourceId(eventId: string): string {
	return createHash("sha256").update(eventId).digest("hex");
}

function withinTolerance(a: Date, b: Date): boolean {
	return (
		Math.abs(a.getTime() - b.getTime()) <= CALENDAR_OCCURRENCE_TOLERANCE_MS
	);
}

/**
 * Whether the member had the agent join this meeting themselves: a session of
 * theirs on its project joined from just before its start until its end.
 */
function joinedByMember(
	sessions: readonly CalendarManualSession[],
	meeting: QualifiedCalendarMeeting,
): boolean {
	const earliest =
		meeting.startAt.getTime() - CALENDAR_OCCURRENCE_TOLERANCE_MS;
	const latest = meeting.endAt.getTime();
	return sessions.some((session) => {
		if (session.projectId !== meeting.projectId || !session.joinedAt) {
			return false;
		}
		const joinedAt = session.joinedAt.getTime();
		return joinedAt >= earliest && joinedAt <= latest;
	});
}

function span(params: {
	kind: CollectedTimeEvidence["kind"];
	sourceId: string;
	projectId: string;
	startAt: Date;
	endAt: Date;
}): CollectedTimeEvidence {
	return {
		kind: params.kind,
		sourceId: params.sourceId,
		projectId: params.projectId,
		storyId: null,
		storyIdentifier: null,
		storyTitle: null,
		occurredAt: params.startAt,
		startAt: params.startAt,
		endAt: params.endAt,
	};
}

/** The evidence the counted meetings become, once each. */
export function buildCalendarTimeEvidence(input: {
	meetings: readonly QualifiedCalendarMeeting[];
	autoSessions: readonly CalendarAutoJoinSession[];
	manualSessions: readonly CalendarManualSession[];
}): CollectedTimeEvidence[] {
	const evidence = new Map<string, CollectedTimeEvidence>();
	for (const meeting of input.meetings) {
		const auto = input.autoSessions.find(
			(session) =>
				session.linkedMeetingId === meeting.linkedMeetingId &&
				session.occurrenceStart !== null &&
				withinTolerance(session.occurrenceStart, meeting.startAt),
		);
		if (auto?.joinedAt && auto.endedAt) {
			evidence.set(
				`MEETING_SESSION:${auto.id}`,
				span({
					kind: "MEETING_SESSION",
					sourceId: auto.id,
					projectId: auto.projectId,
					startAt: auto.joinedAt,
					endAt: auto.endedAt,
				}),
			);
			continue;
		}
		if (joinedByMember(input.manualSessions, meeting)) {
			continue;
		}
		const sourceId = calendarEventSourceId(meeting.eventId);
		evidence.set(
			`CALENDAR_EVENT:${sourceId}`,
			span({
				kind: "CALENDAR_EVENT",
				sourceId,
				projectId: meeting.projectId,
				startAt: meeting.startAt,
				endAt: meeting.endAt,
			}),
		);
	}
	return [...evidence.values()];
}
