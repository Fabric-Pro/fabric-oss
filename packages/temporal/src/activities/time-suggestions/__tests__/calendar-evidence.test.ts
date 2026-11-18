import { createHash } from "node:crypto";
import type { CalendarTimeEvidenceEvent } from "@repo/integrations/microsoft";
import { describe, expect, it } from "vitest";
import {
	buildCalendarTimeEvidence,
	type CalendarAutoJoinSession,
	calendarEventSourceId,
	type QualifiedCalendarMeeting,
	qualifyCalendarMeetings,
} from "../calendar-evidence";

const JOIN_URL = "https://teams.microsoft.com/l/meetup-join/example-series";
const FROM = new Date("2026-11-02T00:00:00.000Z");
const TO = new Date("2026-11-09T00:00:00.000Z");
const at = (iso: string) => new Date(iso);

function calendarEvent(
	overrides: Partial<CalendarTimeEvidenceEvent> = {},
): CalendarTimeEvidenceEvent {
	return {
		id: "event-1",
		startAt: "2026-11-03T09:00:00.000Z",
		endAt: "2026-11-03T09:30:00.000Z",
		joinUrl: JOIN_URL,
		isAllDay: false,
		isCancelled: false,
		showAs: "busy",
		response: "accepted",
		isOrganizer: false,
		...overrides,
	};
}

const series = { id: "series-1", projectId: "project-a", joinUrl: JOIN_URL };

function qualify(
	events: CalendarTimeEvidenceEvent[],
	linkedMeetings = [series],
) {
	return qualifyCalendarMeetings({
		events,
		linkedMeetings,
		from: FROM,
		to: TO,
	});
}

describe("qualifyCalendarMeetings", () => {
	it("keeps an accepted Teams meeting on its one linked series", () => {
		expect(qualify([calendarEvent()])).toEqual([
			{
				eventId: "event-1",
				linkedMeetingId: "series-1",
				projectId: "project-a",
				startAt: at("2026-11-03T09:00:00.000Z"),
				endAt: at("2026-11-03T09:30:00.000Z"),
			},
		]);
	});

	it("counts a meeting the member organized, accepted or marked tentative", () => {
		const events = [
			calendarEvent({ id: "accepted", response: "accepted" }),
			calendarEvent({ id: "tentative", response: "tentativelyAccepted" }),
			calendarEvent({ id: "organizer", response: "organizer" }),
			calendarEvent({
				id: "organized",
				response: "none",
				isOrganizer: true,
			}),
		];

		expect(qualify(events).map((meeting) => meeting.eventId)).toEqual([
			"accepted",
			"tentative",
			"organizer",
			"organized",
		]);
	});

	it.each([
		["declined", calendarEvent({ response: "declined" })],
		["not responded", calendarEvent({ response: "notResponded" })],
		["without a response", calendarEvent({ response: null })],
		["cancelled", calendarEvent({ isCancelled: true })],
		["all-day", calendarEvent({ isAllDay: true })],
		["shown as free", calendarEvent({ showAs: "free" })],
	])("skips a meeting %s", (_label, event) => {
		expect(qualify([event])).toEqual([]);
	});

	it("counts a tentative meeting shown as tentative", () => {
		expect(
			qualify([
				calendarEvent({
					response: "tentativelyAccepted",
					showAs: "tentative",
				}),
			]),
		).toHaveLength(1);
	});

	it("matches the join URL ignoring case and surrounding space", () => {
		const joinUrl = `  ${JOIN_URL.toUpperCase()} `;
		expect(qualify([calendarEvent({ joinUrl })])).toHaveLength(1);
	});

	it("skips a meeting whose series is linked to no project", () => {
		expect(
			qualify([
				calendarEvent({
					joinUrl: "https://teams.microsoft.com/l/meetup-join/other",
				}),
			]),
		).toEqual([]);
	});

	it("skips a meeting whose series is linked to several of the member's projects", () => {
		expect(
			qualify(
				[calendarEvent()],
				[
					series,
					{
						id: "series-2",
						projectId: "project-b",
						joinUrl: JOIN_URL,
					},
				],
			),
		).toEqual([]);
	});

	it.each([
		["no length", "2026-11-03T09:00:00.000Z"],
		["a negative length", "2026-11-03T08:00:00.000Z"],
		["more than one entry's length", "2026-11-04T09:01:00.000Z"],
	])("skips a meeting with %s", (_label, endAt) => {
		expect(qualify([calendarEvent({ endAt })])).toEqual([]);
	});

	it("skips a meeting that started outside the run's window", () => {
		expect(
			qualify([
				calendarEvent({
					startAt: "2026-11-01T23:30:00.000Z",
					endAt: "2026-11-02T00:30:00.000Z",
				}),
				calendarEvent({
					id: "event-2",
					startAt: "2026-11-09T00:00:00.000Z",
					endAt: "2026-11-09T00:30:00.000Z",
				}),
			]),
		).toEqual([]);
	});

	it("skips a meeting without times", () => {
		expect(qualify([calendarEvent({ startAt: null })])).toEqual([]);
	});
});

describe("buildCalendarTimeEvidence", () => {
	const meeting: QualifiedCalendarMeeting = {
		eventId: "event-1",
		linkedMeetingId: "series-1",
		projectId: "project-a",
		startAt: at("2026-11-03T09:00:00.000Z"),
		endAt: at("2026-11-03T09:30:00.000Z"),
	};
	const autoSession: CalendarAutoJoinSession = {
		id: "session-auto",
		projectId: "project-a",
		linkedMeetingId: "series-1",
		occurrenceStart: at("2026-11-03T09:00:00.000Z"),
		joinedAt: at("2026-11-03T08:59:00.000Z"),
		endedAt: at("2026-11-03T09:42:00.000Z"),
	};

	it("becomes a calendar meeting from its start to its end, under a hash of its event id", () => {
		const evidence = buildCalendarTimeEvidence({
			meetings: [meeting],
			autoSessions: [],
			manualSessions: [],
		});

		const hash = createHash("sha256").update("event-1").digest("hex");
		expect(evidence).toEqual([
			{
				kind: "CALENDAR_EVENT",
				sourceId: hash,
				projectId: "project-a",
				storyId: null,
				storyIdentifier: null,
				storyTitle: null,
				occurredAt: meeting.startAt,
				startAt: meeting.startAt,
				endAt: meeting.endAt,
			},
		]);
		expect(calendarEventSourceId("event-1")).toBe(hash);
		expect(JSON.stringify(evidence)).not.toContain("event-1");
	});

	it("credits the agent's own join of that occurrence instead, with the agent's times", () => {
		expect(
			buildCalendarTimeEvidence({
				meetings: [meeting],
				autoSessions: [autoSession],
				manualSessions: [],
			}),
		).toEqual([
			{
				kind: "MEETING_SESSION",
				sourceId: "session-auto",
				projectId: "project-a",
				storyId: null,
				storyIdentifier: null,
				storyTitle: null,
				occurredAt: autoSession.joinedAt,
				startAt: autoSession.joinedAt,
				endAt: autoSession.endedAt,
			},
		]);
	});

	it("does not credit the agent's join of another occurrence of the series", () => {
		const evidence = buildCalendarTimeEvidence({
			meetings: [meeting],
			autoSessions: [
				{
					...autoSession,
					occurrenceStart: at("2026-11-03T09:01:01.000Z"),
				},
				{
					...autoSession,
					id: "session-other",
					linkedMeetingId: "series-2",
				},
			],
			manualSessions: [],
		});

		expect(evidence.map((item) => item.kind)).toEqual(["CALENDAR_EVENT"]);
	});

	it("credits one join once, however many calendar entries match it", () => {
		const evidence = buildCalendarTimeEvidence({
			meetings: [meeting, { ...meeting, eventId: "event-copy" }],
			autoSessions: [autoSession],
			manualSessions: [],
		});

		expect(evidence).toHaveLength(1);
		expect(evidence[0].sourceId).toBe("session-auto");
	});

	it("adds nothing when the member had the agent join the meeting themselves", () => {
		expect(
			buildCalendarTimeEvidence({
				meetings: [meeting],
				autoSessions: [],
				manualSessions: [
					{
						projectId: "project-a",
						joinedAt: at("2026-11-03T08:59:30.000Z"),
					},
				],
			}),
		).toEqual([]);
	});

	it("keeps the meeting when the member's own session was on another project or at another time", () => {
		const evidence = buildCalendarTimeEvidence({
			meetings: [meeting],
			autoSessions: [],
			manualSessions: [
				{
					projectId: "project-b",
					joinedAt: at("2026-11-03T09:05:00.000Z"),
				},
				{
					projectId: "project-a",
					joinedAt: at("2026-11-03T09:31:00.000Z"),
				},
				{ projectId: "project-a", joinedAt: null },
			],
		});

		expect(evidence.map((item) => item.kind)).toEqual(["CALENDAR_EVENT"]);
	});
});
