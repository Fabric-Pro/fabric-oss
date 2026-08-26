import { describe, expect, it } from "vitest";
import {
	dayKey,
	groupAwaitingByDay,
	groupMeetingsByDay,
	monthGridDays,
} from "../group-meetings";
import type { AwaitingMeeting, DigestMeeting } from "../types";

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
});

describe("monthGridDays", () => {
	it("returns a whole-week-aligned grid covering the month", () => {
		const days = monthGridDays(new Date("2026-06-15"));
		expect(days.length % 7).toBe(0);
		expect(days.some((d) => d.getMonth() === 5)).toBe(true); // June present
	});
});
