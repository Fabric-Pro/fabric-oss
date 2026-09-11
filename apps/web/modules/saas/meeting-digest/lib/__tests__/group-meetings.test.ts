import { describe, expect, it } from "vitest";
import {
	dayKey,
	groupAwaitingByDay,
	groupMeetingsByDay,
	groupPersonalMeetingsByDay,
	monthGridDays,
} from "../group-meetings";
import type { AwaitingMeeting, DigestMeeting, PersonalMeeting } from "../types";

const m = (id: string, date: string | null): DigestMeeting => ({
	linkedMeetingId: id,
	transcriptId: `t-${id}`,
	subject: id,
	meetingDate: date ? new Date(date) : null,
	hasTranscript: true,
	analysisStatus: "SCANNED",
	createdTaskCount: 0,
	participantCount: 0,
	includedInDigest: true,
});

describe("groupMeetingsByDay", () => {
	it("buckets meetings by yyyy-MM-dd and drops null dates", () => {
		const grouped = groupMeetingsByDay([
			m("a", "2026-06-10T09:00:00Z"),
			m("b", "2026-06-10T15:00:00Z"),
			m("c", "2026-06-12T10:00:00Z"),
			m("d", null),
		]);
		expect(
			grouped.get("2026-06-10")?.map((x) => x.linkedMeetingId),
		).toEqual(["a", "b"]);
		expect(grouped.get("2026-06-12")?.length).toBe(1);
		expect([...grouped.keys()]).not.toContain("");
	});

	it("sorts meetings within a day chronologically ascending (earlier meetings first)", () => {
		// When input arrives in reverse-chronological order (e.g. from orderBy: { meetingDate: "desc" })
		const grouped = groupMeetingsByDay([
			m("afternoon", "2026-09-09T15:00:00Z"),
			m("morning", "2026-09-09T09:00:00Z"),
			m("lunch", "2026-09-09T12:30:00Z"),
		]);
		expect(
			grouped.get("2026-09-09")?.map((x) => x.linkedMeetingId),
		).toEqual(["morning", "lunch", "afternoon"]);
	});
});

const awaiting = (occurrenceStart: string | Date): AwaitingMeeting => ({
	linkedMeetingId: "lm1",
	subject: "DSU",
	occurrenceStart,
});

describe("groupAwaitingByDay", () => {
	it("buckets an occurrence under the shared day key", () => {
		const date = new Date("2026-07-15T09:00:00Z");
		const grouped = groupAwaitingByDay([awaiting(date)]);
		expect(grouped.get(dayKey(date))).toHaveLength(1);
	});

	it("accepts an ISO string as well as a Date", () => {
		const iso = "2026-07-15T09:00:00Z";
		const grouped = groupAwaitingByDay([awaiting(iso)]);
		expect(grouped.get(dayKey(new Date(iso)))).toHaveLength(1);
	});

	it("drops an unparseable occurrence rather than bucketing it wrongly", () => {
		expect(groupAwaitingByDay([awaiting("not-a-date")]).size).toBe(0);
	});

	it("groups two occurrences of the same day together", () => {
		const grouped = groupAwaitingByDay([
			awaiting(new Date("2026-07-15T09:00:00Z")),
			awaiting(new Date("2026-07-15T14:00:00Z")),
		]);
		expect([...grouped.values()][0]).toHaveLength(2);
	});

	it("sorts awaiting meetings within a day chronologically ascending", () => {
		const grouped = groupAwaitingByDay([
			{
				linkedMeetingId: "afternoon",
				subject: "Review",
				occurrenceStart: "2026-07-15T15:00:00Z",
				joinUrl: "https://teams.microsoft.com/l/meetup-join/test",
			},
			{
				linkedMeetingId: "morning",
				subject: "DSU",
				occurrenceStart: "2026-07-15T09:00:00Z",
				joinUrl: "https://teams.microsoft.com/l/meetup-join/test",
			},
			{
				linkedMeetingId: "lunch",
				subject: "Sync",
				occurrenceStart: "2026-07-15T12:00:00Z",
				joinUrl: "https://teams.microsoft.com/l/meetup-join/test",
			},
		]);
		expect(
			grouped.get("2026-07-15")?.map((x) => x.linkedMeetingId),
		).toEqual(["morning", "lunch", "afternoon"]);
	});
});

const personal = (id: string, startTime: string | null): PersonalMeeting => ({
	id,
	subject: id,
	startTime,
	organizer: "Alex Doe",
	joinUrl: "https://teams.microsoft.com/l/meetup-join/test",
	linkedWithoutTranscript: false,
});

describe("groupPersonalMeetingsByDay", () => {
	it("buckets personal meetings by day and drops null or invalid dates", () => {
		const grouped = groupPersonalMeetingsByDay([
			personal("p1", "2026-07-15T09:00:00Z"),
			personal("p2", "2026-07-15T14:00:00Z"),
			personal("p3", null),
			personal("p4", "invalid-date"),
		]);
		expect(grouped.get("2026-07-15")?.map((x) => x.id)).toEqual([
			"p1",
			"p2",
		]);
		expect(grouped.size).toBe(1);
	});

	it("sorts personal meetings within a day chronologically ascending", () => {
		const grouped = groupPersonalMeetingsByDay([
			personal("afternoon", "2026-07-15T16:00:00Z"),
			personal("morning", "2026-07-15T08:30:00Z"),
			personal("noon", "2026-07-15T12:00:00Z"),
		]);
		expect(grouped.get("2026-07-15")?.map((x) => x.id)).toEqual([
			"morning",
			"noon",
			"afternoon",
		]);
	});
});

describe("monthGridDays", () => {
	it("returns a whole-week-aligned grid covering the month", () => {
		const days = monthGridDays(new Date("2026-06-15"));
		expect(days.length % 7).toBe(0);
		expect(days.some((d) => d.getMonth() === 5)).toBe(true); // June present
	});
});
