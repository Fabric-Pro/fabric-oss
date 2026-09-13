import { describe, expect, it } from "vitest";
import { mergeDayRows } from "../day-rows";
import type { AwaitingMeeting, DigestMeeting, PersonalMeeting } from "../types";

const team = (transcriptId: string, at: string): DigestMeeting => ({
	linkedMeetingId: `lm-${transcriptId}`,
	transcriptId,
	transcriptRef: `ref-${transcriptId}`,
	subject: transcriptId,
	meetingDate: new Date(at),
	hasTranscript: true,
	analysisStatus: "SCANNED",
	createdTaskCount: 0,
	participantCount: 2,
	includedInDigest: true,
	insightsReady: false,
	decisions: [],
	actionItems: [],
	openQuestions: [],
});

const awaiting = (id: string, at: string): AwaitingMeeting => ({
	linkedMeetingId: id,
	subject: id,
	occurrenceStart: at,
	joinUrl: "https://teams.microsoft.com/l/meetup-join/test",
});

const personal = (id: string, at: string | null): PersonalMeeting => ({
	id,
	subject: id,
	startTime: at,
	organizer: "Alex Doe",
	joinUrl: "https://teams.microsoft.com/l/meetup-join/test",
	linkedWithoutTranscript: false,
});

describe("mergeDayRows", () => {
	it("orders every lane by time rather than by lane", () => {
		const rows = mergeDayRows({
			team: [team("team-15", "2026-09-09T15:00:00Z")],
			awaiting: [awaiting("awaiting-12", "2026-09-09T12:00:00Z")],
			personal: [personal("personal-09", "2026-09-09T09:00:00Z")],
		});

		expect(rows.map((row) => row.key)).toEqual([
			"personal-09",
			"awaiting-12:2026-09-09T12:00:00.000Z",
			"team-15",
		]);
	});

	it("tags each row with the lane it came from", () => {
		const rows = mergeDayRows({
			team: [team("t", "2026-09-09T09:00:00Z")],
			awaiting: [awaiting("a", "2026-09-09T10:00:00Z")],
			personal: [personal("p", "2026-09-09T11:00:00Z")],
		});

		expect(rows.map((row) => row.kind)).toEqual([
			"team",
			"awaiting",
			"personal",
		]);
	});

	it("keeps lane order for rows at the same instant", () => {
		const at = "2026-09-09T09:00:00Z";
		const rows = mergeDayRows({
			team: [team("t", at)],
			awaiting: [awaiting("a", at)],
			personal: [personal("p", at)],
		});

		expect(rows.map((row) => row.kind)).toEqual([
			"team",
			"awaiting",
			"personal",
		]);
	});

	it("assigns each row its lane's stable identity so rows do not remount", () => {
		const rows = mergeDayRows({
			team: [team("graph-1", "2026-09-09T09:00:00Z")],
			awaiting: [awaiting("lm9", "2026-09-09T10:00:00Z")],
			personal: [personal("evt1", "2026-09-09T11:00:00Z")],
		});

		expect(rows.map((row) => row.key)).toEqual([
			"graph-1",
			"lm9:2026-09-09T10:00:00.000Z",
			"evt1",
		]);
	});

	it("treats absent lanes as empty", () => {
		expect(mergeDayRows({})).toEqual([]);
		expect(
			mergeDayRows({ team: [team("t", "2026-09-09T09:00:00Z")] }),
		).toHaveLength(1);
	});

	it("sorts rows with missing or null time to the end", () => {
		const rows = mergeDayRows({
			personal: [personal("p-nodate", null)],
			team: [team("t-dated", "2026-09-09T09:00:00Z")],
		});
		expect(rows.map((row) => row.key)).toEqual(["t-dated", "p-nodate"]);
	});
});
