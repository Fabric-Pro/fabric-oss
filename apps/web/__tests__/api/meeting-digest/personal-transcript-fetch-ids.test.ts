import { fetchPersonalTranscriptContent } from "@repo/api/modules/projects/procedures/meeting-digest/personal-transcript-fetch";
import { describe, expect, it, vi } from "vitest";

/**
 * #2170 — the shared personal-transcript read now also reports WHICH Graph
 * meeting and transcript it resolved.
 *
 * The import procedure needs those two ids as its dedup key: a Graph transcript
 * is immutable once produced, so `(meetingId, transcriptId)` is the only value
 * that means "this exact occurrence's content" — `joinUrl` is shared by every
 * instance of a recurring series, and the calendar `startTime` is the event's
 * time, not the transcript's.
 *
 * Additive by design: the existing callers destructure `content`/`reason` and
 * are unaffected, and `getPersonalTranscript` projects the ids back out so the
 * client contract does not grow.
 */

const joinUrl = "https://teams.microsoft.com/l/meetup-join/abc";

function graphStub(overrides: Record<string, unknown> = {}) {
	const responses: Record<string, unknown> = {
		get_meeting_by_join_url: { meeting: { id: "meeting-1" } },
		list_meeting_transcripts: {
			transcripts: [
				{ id: "transcript-1", createdDateTime: "2026-08-14T09:05:00Z" },
			],
		},
		get_meeting_transcript_content: {
			entries: [{ speaker: "Ada", text: "morning" }],
		},
		...overrides,
	};
	return vi.fn(async (methodName: string) => responses[methodName]);
}

describe("fetchPersonalTranscriptContent", () => {
	it("reports the resolved meeting and transcript ids alongside the content", async () => {
		const result = await fetchPersonalTranscriptContent({
			callGraph: graphStub(),
			joinUrl,
			startTime: "2026-08-14T09:00:00Z",
		});

		expect(result).toEqual({
			content: "Ada: morning",
			meetingId: "meeting-1",
			transcriptId: "transcript-1",
		});
	});

	it("reports the ids of the occurrence it actually picked, not the first listed", async () => {
		const result = await fetchPersonalTranscriptContent({
			callGraph: graphStub({
				list_meeting_transcripts: {
					transcripts: [
						{
							id: "last-week",
							createdDateTime: "2026-08-07T09:05:00Z",
						},
						{
							id: "this-week",
							createdDateTime: "2026-08-14T09:05:00Z",
						},
					],
				},
			}),
			joinUrl,
			startTime: "2026-08-14T09:00:00Z",
		});

		expect(result).toMatchObject({ transcriptId: "this-week" });
	});

	// Every non-success branch must stay id-free: there is no occurrence to
	// identify, and an import keyed off a half-populated result would be worse
	// than no import at all.
	it.each([
		[
			"no meeting resolves from the join URL",
			{ get_meeting_by_join_url: { meeting: null } },
			"no-transcript",
		],
		[
			"the meeting has no transcripts",
			{ list_meeting_transcripts: { transcripts: [] } },
			"no-transcript",
		],
		[
			"the tenant blocks Graph transcript access",
			{
				list_meeting_transcripts: {
					helpUrl: "https://aka.ms/help",
					error: "Microsoft Graph access to meeting transcripts is disabled for this tenant",
				},
			},
			"transcript-access-disabled",
		],
		[
			"the app registration lacks the transcript permission",
			{
				list_meeting_transcripts: {
					helpUrl: "https://aka.ms/help",
					error: "Forbidden",
				},
			},
			"admin-consent-required",
		],
		[
			"the transcript body is empty",
			{ get_meeting_transcript_content: { content: "   " } },
			"no-transcript",
		],
	])("returns no ids when %s", async (_case, overrides, reason) => {
		const result = await fetchPersonalTranscriptContent({
			callGraph: graphStub(overrides as Record<string, unknown>),
			joinUrl,
			startTime: "2026-08-14T09:00:00Z",
		});

		expect(result).toEqual({ content: null, reason });
	});
});
