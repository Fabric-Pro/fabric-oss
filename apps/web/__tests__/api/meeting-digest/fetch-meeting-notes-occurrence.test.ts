import { beforeEach, describe, expect, it, vi } from "vitest";

const { hasProjectAccess, executeMicrosoftTeamsTool } = vi.hoisted(() => ({
	hasProjectAccess: vi.fn(),
	executeMicrosoftTeamsTool: vi.fn(),
}));

vi.mock("@repo/database", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@repo/database")>();
	return { ...actual, hasProjectAccess };
});

vi.mock("@repo/integrations/microsoft", () => ({
	executeMicrosoftTeamsTool,
}));

import { fetchMeetingNotesProcedure } from "@repo/api/modules/projects/procedures/documents/fetch-meeting-notes";

/**
 * A recurring series lists every occurrence's transcript, so the document
 * editor's meeting notes must reject a transcript that `selectTranscriptId`'s
 * cover rule does not place on the selected occurrence, instead of taking the
 * nearest one from another day (Fizzy #3253).
 */
describe("fetchMeetingNotesProcedure — recurring occurrence pick", () => {
	beforeEach(() => {
		hasProjectAccess.mockReset().mockResolvedValue(true);
		executeMicrosoftTeamsTool
			.mockReset()
			.mockImplementation(
				async (method: string, args: { transcriptId?: string }) => {
					if (method === "get_meeting_by_join_url") {
						return { meeting: { id: "m1", subject: "Standup" } };
					}
					if (method === "list_meeting_transcripts") {
						return {
							transcripts: [
								{
									id: "t-12",
									createdDateTime: "2026-10-12T16:00:57Z",
								},
							],
						};
					}
					return {
						entries: [
							{ speaker: "Alice", text: `${args.transcriptId}` },
						],
					};
				},
			);
	});

	const call = (startTime: string) =>
		fetchMeetingNotesProcedure["~orpc"].handler({
			input: {
				projectId: "p1",
				organizationId: null,
				selectedMeetings: [
					{ joinUrl: "https://example.com/meeting", startTime },
				],
			},
			context: { user: { id: "u1" }, session: {} },
			errors: {},
		} as never);

	it("reports no transcript instead of another day's for an untranscribed occurrence", async () => {
		const result = await call("2026-10-13T16:00:00Z");

		expect(result.notes).toEqual([
			{
				subject: "Standup",
				content: "",
				error: expect.stringMatching(/No transcript available/),
			},
		]);
		expect(
			executeMicrosoftTeamsTool.mock.calls.map(([method]) => method),
		).not.toContain("get_meeting_transcript_content");
	});

	it("returns the selected occurrence's own transcript", async () => {
		const result = await call("2026-10-12T16:00:00Z");

		expect(result.notes).toEqual([
			{ subject: "Standup", content: "Alice: t-12" },
		]);
	});
});
