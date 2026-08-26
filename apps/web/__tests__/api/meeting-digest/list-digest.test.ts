import { computeActionItemKey } from "@repo/database";
import { MEETING_INSIGHTS_VERSION } from "@repo/temporal/activities";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
	findManyLinked,
	findManyTranscript,
	findManySessions,
	findManyAgenda,
	hasAccess,
} = vi.hoisted(() => ({
	findManyLinked: vi.fn(),
	findManyTranscript: vi.fn(),
	findManySessions: vi.fn(),
	findManyAgenda: vi.fn(),
	hasAccess: vi.fn(),
}));

vi.mock("@repo/database", async (importOriginal) => {
	const actual = await importOriginal();
	return {
		...actual,
		db: {
			projectLinkedMeeting: { findMany: findManyLinked },
			projectMeetingTranscript: { findMany: findManyTranscript },
			backlogUpdateSession: { findMany: findManySessions },
			projectMeetingAgenda: { findMany: findManyAgenda },
		},
		hasProjectAccess: hasAccess,
	};
});

import {
	buildAwaitingOccurrences,
	buildDigestRows,
	findSeriesWithoutTranscripts,
} from "@repo/api/modules/projects/procedures/meeting-digest/list-digest";

describe("buildDigestRows", () => {
	beforeEach(() => vi.clearAllMocks());

	it("maps a transcript to a digest row with created-task count and participants", () => {
		const rows = buildDigestRows({
			linked: [{ id: "lm1", subject: "DSU", includedInDigest: true }],
			transcripts: [
				{
					id: "cuidA",
					linkedMeetingId: "lm1",
					transcriptId: "t1",
					meetingDate: new Date("2026-06-10"),
					contextId: "ctx1",
					speakerNames: ["Ann", "Bob"],
					analysisStatus: "SCANNED",
					analyzedProposalId: "p1",
					insightsExtractedAt: null,
					insightsVersion: null,
					extractedDecisions: [],
					extractedQuestions: [],
					extractedActionItems: null,
					actionItemRows: [],
				},
			],
			createCountByProposalId: new Map([["p1", 3]]),
		});

		expect(rows).toEqual([
			{
				linkedMeetingId: "lm1",
				transcriptId: "t1",
				transcriptRef: "cuidA",
				subject: "DSU",
				meetingDate: new Date("2026-06-10"),
				hasTranscript: true,
				analysisStatus: "SCANNED",
				createdTaskCount: 3,
				participantCount: 2,
				includedInDigest: true,
				insightsReady: false,
				decisions: [],
				openQuestions: [],
				actionItems: [],
			},
		]);
	});

	it("defaults created-task count to 0 when no proposal/session exists", () => {
		const rows = buildDigestRows({
			linked: [{ id: "lm1", subject: "DSU", includedInDigest: true }],
			transcripts: [
				{
					id: "cuidB",
					linkedMeetingId: "lm1",
					transcriptId: "t1",
					meetingDate: null,
					contextId: null,
					speakerNames: [],
					analysisStatus: "NOT_SCANNED",
					analyzedProposalId: null,
					insightsExtractedAt: null,
					insightsVersion: null,
					extractedDecisions: [],
					extractedQuestions: [],
					extractedActionItems: null,
					actionItemRows: [],
				},
			],
			createCountByProposalId: new Map(),
		});
		expect(rows[0].createdTaskCount).toBe(0);
		expect(rows[0].hasTranscript).toBe(false);
		expect(rows[0]).toEqual({
			linkedMeetingId: "lm1",
			transcriptId: "t1",
			transcriptRef: "cuidB",
			subject: "DSU",
			meetingDate: null,
			hasTranscript: false,
			analysisStatus: "NOT_SCANNED",
			createdTaskCount: 0,
			participantCount: 0,
			includedInDigest: true,
			insightsReady: false,
			decisions: [],
			openQuestions: [],
			actionItems: [],
		});
	});

	it("exposes insights fields on digest rows", () => {
		const rows = buildDigestRows({
			linked: [{ id: "lm1", subject: "DSU", includedInDigest: true }],
			transcripts: [
				{
					id: "cuid1",
					linkedMeetingId: "lm1",
					transcriptId: "graph-t1",
					meetingDate: new Date("2026-07-06"),
					contextId: "ctx1",
					speakerNames: ["A", "B"],
					analysisStatus: "SCANNED",
					analyzedProposalId: null,
					insightsExtractedAt: new Date(),
					insightsVersion: MEETING_INSIGHTS_VERSION,
					extractedDecisions: [{ text: "ship it" }],
					extractedQuestions: [{ text: "when?" }],
					extractedActionItems: null,
					actionItemRows: [
						{
							id: "a1",
							orderIndex: 0,
							text: "do it",
							tentativeOwnerName: null,
							dueHint: null,
							completedAt: null,
						},
					],
				},
			],
			createCountByProposalId: new Map(),
		});
		expect(rows[0]).toMatchObject({
			transcriptRef: "cuid1",
			insightsReady: true,
			decisions: [{ text: "ship it" }],
			openQuestions: [{ text: "when?" }],
			actionItems: [{ id: "a1", text: "do it" }],
		});
	});

	it("falls back to legacy Json action items (non-checkable, id: null) when a transcript has zero action-item rows", () => {
		const rows = buildDigestRows({
			linked: [{ id: "lm1", subject: "DSU", includedInDigest: true }],
			transcripts: [
				{
					id: "cuidPre",
					linkedMeetingId: "lm1",
					transcriptId: "t1",
					meetingDate: new Date("2026-06-01"),
					contextId: "ctx1",
					speakerNames: [],
					analysisStatus: "SCANNED",
					analyzedProposalId: null,
					insightsExtractedAt: new Date(),
					insightsVersion: MEETING_INSIGHTS_VERSION,
					extractedDecisions: [],
					extractedQuestions: [],
					extractedActionItems: [
						{
							text: "legacy pre-backfill item",
							tentativeOwnerName: "Bo",
						},
					],
					actionItemRows: [],
				},
			],
			createCountByProposalId: new Map(),
		});
		expect(rows[0].actionItems).toEqual([
			{
				id: null,
				text: "legacy pre-backfill item",
				tentativeOwnerName: "Bo",
				dueHint: null,
				completedAt: null,
				sourceQuote: null,
				anchorLine: null,
				// #1902: computed from the text, so legacy Json items carry a
				// join key too.
				itemKey: computeActionItemKey("legacy pre-backfill item"),
			},
		]);
	});
});

describe("findSeriesWithoutTranscripts", () => {
	it("returns included series that have no transcript rows", () => {
		expect(
			findSeriesWithoutTranscripts({
				linked: [
					{ id: "lm1", subject: "DSU", includedInDigest: true },
					{ id: "lm2", subject: "Retro", includedInDigest: true },
					{ id: "lm3", subject: "1:1", includedInDigest: false },
				],
				transcriptLinkedIds: ["lm1"],
			}),
		).toEqual([{ linkedMeetingId: "lm2", subject: "Retro" }]);
	});

	it("returns empty when every included series has transcripts", () => {
		expect(
			findSeriesWithoutTranscripts({
				linked: [{ id: "lm1", subject: "DSU", includedInDigest: true }],
				transcriptLinkedIds: ["lm1"],
			}),
		).toEqual([]);
	});

	it("drops a series that produced a dated awaiting row", () => {
		expect(
			findSeriesWithoutTranscripts({
				linked: [
					{ id: "lm1", subject: "DSU", includedInDigest: true },
					{ id: "lm2", subject: "Retro", includedInDigest: true },
				],
				transcriptLinkedIds: [],
				awaitingLinkedIds: ["lm1"],
			}),
		).toEqual([{ linkedMeetingId: "lm2", subject: "Retro" }]);
	});

	it("keeps every series when nothing is awaiting", () => {
		expect(
			findSeriesWithoutTranscripts({
				linked: [{ id: "lm1", subject: "DSU", includedInDigest: true }],
				transcriptLinkedIds: [],
				awaitingLinkedIds: [],
			}),
		).toEqual([{ linkedMeetingId: "lm1", subject: "DSU" }]);
	});
});

describe("buildAwaitingOccurrences", () => {
	const NOW = new Date("2026-07-20T12:00:00Z");
	const linked = [
		{
			id: "lm1",
			subject: "DSU",
			includedInDigest: true,
			joinUrl: "https://teams.microsoft.com/l/meetup-join/AAA",
		},
		{
			id: "lm2",
			subject: "Excluded",
			includedInDigest: false,
			joinUrl: "https://teams.microsoft.com/l/meetup-join/BBB",
		},
	];

	it("emits a row for a past occurrence with no transcript", () => {
		expect(
			buildAwaitingOccurrences({
				linked,
				agendas: [
					{
						linkedMeetingId: "lm1",
						occurrenceStart: new Date("2026-07-15T09:00:00Z"),
					},
				],
				transcripts: [],
				now: NOW,
			}),
		).toEqual([
			{
				linkedMeetingId: "lm1",
				subject: "DSU",
				occurrenceStart: new Date("2026-07-15T09:00:00Z"),
				joinUrl: "https://teams.microsoft.com/l/meetup-join/AAA",
			},
		]);
	});

	it("does not emit a row for a future occurrence", () => {
		expect(
			buildAwaitingOccurrences({
				linked,
				agendas: [
					{
						linkedMeetingId: "lm1",
						occurrenceStart: new Date("2026-07-25T09:00:00Z"),
					},
				],
				transcripts: [],
				now: NOW,
			}),
		).toEqual([]);
	});

	it("does not emit a row when a transcript exists on the same UTC day", () => {
		expect(
			buildAwaitingOccurrences({
				linked,
				agendas: [
					{
						linkedMeetingId: "lm1",
						occurrenceStart: new Date("2026-07-15T09:00:00Z"),
					},
				],
				// Different clock time, same UTC day — still a match.
				transcripts: [
					{
						linkedMeetingId: "lm1",
						meetingDate: new Date("2026-07-15T16:30:00Z"),
					},
				],
				now: NOW,
			}),
		).toEqual([]);
	});

	it("still emits when the transcript is on a different day", () => {
		const rows = buildAwaitingOccurrences({
			linked,
			agendas: [
				{
					linkedMeetingId: "lm1",
					occurrenceStart: new Date("2026-07-15T09:00:00Z"),
				},
			],
			transcripts: [
				{
					linkedMeetingId: "lm1",
					meetingDate: new Date("2026-07-14T09:00:00Z"),
				},
			],
			now: NOW,
		});
		expect(rows).toHaveLength(1);
	});

	it("ignores series that are excluded from the digest", () => {
		expect(
			buildAwaitingOccurrences({
				linked,
				agendas: [
					{
						linkedMeetingId: "lm2",
						occurrenceStart: new Date("2026-07-15T09:00:00Z"),
					},
				],
				transcripts: [],
				now: NOW,
			}),
		).toEqual([]);
	});

	it("ignores agendas for a series that is not linked at all", () => {
		expect(
			buildAwaitingOccurrences({
				linked,
				agendas: [
					{
						linkedMeetingId: "ghost",
						occurrenceStart: new Date("2026-07-15T09:00:00Z"),
					},
				],
				transcripts: [],
				now: NOW,
			}),
		).toEqual([]);
	});

	it("collapses two agendas for the same series on one UTC day", () => {
		const rows = buildAwaitingOccurrences({
			linked,
			agendas: [
				{
					linkedMeetingId: "lm1",
					occurrenceStart: new Date("2026-07-15T09:00:00Z"),
				},
				{
					linkedMeetingId: "lm1",
					occurrenceStart: new Date("2026-07-15T14:00:00Z"),
				},
			],
			transcripts: [],
			now: NOW,
		});
		expect(rows).toHaveLength(1);
	});

	it("sorts newest occurrence first", () => {
		const rows = buildAwaitingOccurrences({
			linked,
			agendas: [
				{
					linkedMeetingId: "lm1",
					occurrenceStart: new Date("2026-07-10T09:00:00Z"),
				},
				{
					linkedMeetingId: "lm1",
					occurrenceStart: new Date("2026-07-18T09:00:00Z"),
				},
			],
			transcripts: [],
			now: NOW,
		});
		expect(rows.map((r) => r.occurrenceStart.toISOString())).toEqual([
			"2026-07-18T09:00:00.000Z",
			"2026-07-10T09:00:00.000Z",
		]);
	});

	it("matches a transcript created after the meeting crossed UTC midnight", () => {
		// meetingDate is the TRANSCRIPT's createdDateTime (sync activity line
		// ~400), not the meeting's start. A 19:00 ET meeting starts 23:00 UTC and
		// its transcript is created just after 00:00 UTC the NEXT day, so a
		// same-UTC-day comparison would call a synced meeting "not synced".
		expect(
			buildAwaitingOccurrences({
				linked,
				agendas: [
					{
						linkedMeetingId: "lm1",
						occurrenceStart: new Date("2026-07-15T23:00:00Z"),
					},
				],
				transcripts: [
					{
						linkedMeetingId: "lm1",
						meetingDate: new Date("2026-07-16T00:05:00Z"),
					},
				],
				now: NOW,
			}),
		).toEqual([]);
	});

	it("does not let the next day's transcript cover a missed daily occurrence", () => {
		// Daily standup: Jul 15 has no transcript, Jul 16 does. The Jul 15
		// occurrence must still be reported — a 24h window anchored on the start
		// must not reach forward into the next day's meeting.
		const rows = buildAwaitingOccurrences({
			linked,
			agendas: [
				{
					linkedMeetingId: "lm1",
					occurrenceStart: new Date("2026-07-15T09:00:00Z"),
				},
			],
			transcripts: [
				{
					linkedMeetingId: "lm1",
					meetingDate: new Date("2026-07-16T09:30:00Z"),
				},
			],
			now: NOW,
		});
		expect(rows).toHaveLength(1);
	});

	it("ignores transcripts with no meetingDate", () => {
		const rows = buildAwaitingOccurrences({
			linked,
			agendas: [
				{
					linkedMeetingId: "lm1",
					occurrenceStart: new Date("2026-07-15T09:00:00Z"),
				},
			],
			transcripts: [{ linkedMeetingId: "lm1", meetingDate: null }],
			now: NOW,
		});
		expect(rows).toHaveLength(1);
	});
});
