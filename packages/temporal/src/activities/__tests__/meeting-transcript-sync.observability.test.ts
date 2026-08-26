/**
 * Tests for the channel-meeting recording fallback and the three signals that
 * let a tenant-wide transcript outage read as ordinary quiet for days:
 *
 *   - an empty transcript list that meant "withheld", reported as "none exist"
 *   - a calendar read that failed, reported as "no meetings matched"
 *   - a last-run timestamp stamped on projects whose scheduled sync is off
 *
 * Mock shape follows `meeting-transcript-sync.test.ts` (mocks first, subject
 * imported after).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	executeMicrosoftTeamsToolMock: vi.fn(),
	isTranscriptAlreadySyncedMock: vi.fn(),
	hasTranscriptNearOccurrenceMock: vi.fn(),
	createMeetingTranscriptRecordMock: vi.fn(),
	updateLastRunMock: vi.fn(),
	projectContextCreateMock: vi.fn(),
	projectFindUniqueMock: vi.fn(),
	getTemporalClientMock: vi.fn(),
	workflowStartMock: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	db: {
		projectContext: {
			create: (...a: unknown[]) => mocks.projectContextCreateMock(...a),
		},
		project: {
			findUnique: (...a: unknown[]) => mocks.projectFindUniqueMock(...a),
		},
	},
	createMeetingTranscriptRecord: (...a: unknown[]) =>
		mocks.createMeetingTranscriptRecordMock(...a),
	isTranscriptAlreadySynced: (...a: unknown[]) =>
		mocks.isTranscriptAlreadySyncedMock(...a),
	hasTranscriptNearOccurrence: (...a: unknown[]) =>
		mocks.hasTranscriptNearOccurrenceMock(...a),
	updateMeetingTranscriptSyncLastRun: (...a: unknown[]) =>
		mocks.updateLastRunMock(...a),
	getLinkedMeetingJoinUrls: vi.fn(),
}));

vi.mock("@repo/integrations/microsoft", () => ({
	executeMicrosoftTeamsTool: (...a: unknown[]) =>
		mocks.executeMicrosoftTeamsToolMock(...a),
	// Mirrors the real helper, which decodes before matching — a join URL carries
	// the thread id percent-encoded. Its own behaviour is covered by
	// `packages/integrations/src/microsoft/__tests__/stream-transcript.test.ts`.
	extractChannelThreadId: (joinUrl: string) =>
		decodeURIComponent(joinUrl).includes("@thread.tacv2")
			? "19:thread@thread.tacv2"
			: null,
	isMicrosoftNotConnectedError: (message: string) =>
		message.includes("Microsoft not connected") ||
		message.includes("Microsoft account in Settings"),
}));

vi.mock("@repo/ai", () => ({
	generateText: vi.fn(),
	getAIModelWithMetadata: vi.fn(),
	logModelUsageAsync: vi.fn(),
}));

vi.mock("@temporalio/activity", () => ({
	heartbeat: () => {},
}));

vi.mock("../../client", () => ({
	getTemporalClient: (...a: unknown[]) => mocks.getTemporalClientMock(...a),
}));

// Import AFTER mocks.
import {
	describeMissingTranscripts,
	fetchAndStoreMeetingTranscript,
	listRecentMeetingInstancesForLinkedUrls,
	updateMeetingTranscriptSyncLastRunActivity,
} from "../meeting-transcript-sync";

const CHANNEL_JOIN_URL =
	"https://teams.microsoft.com/l/meetup-join/19%3afake%40thread.tacv2/1700000000000";
const ORDINARY_JOIN_URL =
	"https://teams.microsoft.com/l/meetup-join/19%3ameeting_ZmFrZQ%40thread.v2/0";

const BASE_INPUT = {
	projectId: "proj-1",
	linkedMeetingId: "lm-1",
	userId: "u-1",
	organizationId: "o-1",
	joinUrl: CHANNEL_JOIN_URL,
	meetingSubject: "Team Sync",
	meetingDate: "2026-08-20T16:00:00.000Z",
};

/**
 * Graph resolves the meeting but serves no transcripts — the exact shape a
 * channel meeting produces.
 */
function wireGraphWithNoTranscripts(
	extra: (tool: string) => Record<string, unknown> | undefined = () =>
		undefined,
) {
	mocks.executeMicrosoftTeamsToolMock.mockImplementation(
		async (tool: string) => {
			const override = extra(tool);
			if (override) {
				return override;
			}
			if (tool === "get_meeting_by_join_url") {
				return { meeting: { id: "meeting-1", subject: "Team Sync" } };
			}
			if (tool === "list_meeting_transcripts") {
				return { transcripts: [], count: 0 };
			}
			return {};
		},
	);
}

beforeEach(() => {
	for (const m of Object.values(mocks)) {
		m.mockReset();
	}
	mocks.isTranscriptAlreadySyncedMock.mockResolvedValue(false);
	mocks.hasTranscriptNearOccurrenceMock.mockResolvedValue(false);
	mocks.projectContextCreateMock.mockResolvedValue({ id: "ctx-1" });
	mocks.createMeetingTranscriptRecordMock.mockResolvedValue({
		id: "tr-rec-1",
	});
	mocks.projectFindUniqueMock.mockResolvedValue({
		meetingTranscriptSyncEnabled: false,
		meetingTranscriptAutoAnalyzeEnabled: false,
	});
	mocks.workflowStartMock.mockResolvedValue({ workflowId: "wf-1" });
	mocks.getTemporalClientMock.mockResolvedValue({
		workflow: { start: (...a: unknown[]) => mocks.workflowStartMock(...a) },
	});
});

describe("fetchAndStoreMeetingTranscript — channel meeting recording fallback", () => {
	it("ingests the recording's transcript when Graph serves none for a channel meeting", async () => {
		wireGraphWithNoTranscripts((tool) => {
			if (tool === "list_recording_transcripts") {
				return {
					transcripts: [
						{
							id: "stream:rec-20",
							createdDateTime: "2026-08-20T17:10:00Z",
							driveId: "drive-1",
							recordingItemId: "rec-20",
							recordingWebUrl:
								"https://example.sharepoint.com/sites/S/rec20.mp4",
						},
					],
				};
			}
			if (tool === "get_recording_transcript_content") {
				return {
					format: "structured",
					entries: [
						{ speaker: "Alice", text: "Standup notes." },
						{ speaker: "Bob", text: "Blocked on review." },
					],
					count: 2,
					speakerCount: 2,
				};
			}
			return undefined;
		});

		const result = await fetchAndStoreMeetingTranscript(BASE_INPUT);

		expect(result.success).toBe(true);
		expect(result.transcriptsFetched).toBe(1);

		const tools = mocks.executeMicrosoftTeamsToolMock.mock.calls.map(
			(call) => call[0],
		);
		expect(tools).toContain("list_recording_transcripts");
		expect(tools).toContain("get_recording_transcript_content");
		// The Graph content endpoint has nothing to serve here and must not be
		// asked.
		expect(tools).not.toContain("get_meeting_transcript_content");
	});

	it("dedups on the recording, so a re-run does not ingest the same occurrence twice", async () => {
		mocks.isTranscriptAlreadySyncedMock.mockResolvedValue(true);
		wireGraphWithNoTranscripts((tool) =>
			tool === "list_recording_transcripts"
				? {
						transcripts: [
							{
								id: "stream:rec-20",
								createdDateTime: "2026-08-20T17:10:00Z",
								driveId: "drive-1",
								recordingItemId: "rec-20",
								recordingWebUrl:
									"https://example.sharepoint.com/sites/S/rec20.mp4",
							},
						],
					}
				: undefined,
		);

		const result = await fetchAndStoreMeetingTranscript(BASE_INPUT);

		expect(result.transcriptsFetched).toBe(0);
		expect(mocks.isTranscriptAlreadySyncedMock).toHaveBeenCalledWith(
			"proj-1",
			"meeting-1",
			"stream:rec-20",
		);
		expect(mocks.projectContextCreateMock).not.toHaveBeenCalled();
	});

	it("records which source a transcript came from", async () => {
		wireGraphWithNoTranscripts((tool) => {
			if (tool === "list_recording_transcripts") {
				return {
					transcripts: [
						{
							id: "stream:rec-20",
							createdDateTime: "2026-08-20T17:10:00Z",
							driveId: "drive-1",
							recordingItemId: "rec-20",
							recordingWebUrl:
								"https://example.sharepoint.com/sites/S/rec20.mp4",
						},
					],
				};
			}
			if (tool === "get_recording_transcript_content") {
				return { entries: [{ speaker: "Alice", text: "Hello." }] };
			}
			return undefined;
		});

		await fetchAndStoreMeetingTranscript(BASE_INPUT);

		const created = mocks.projectContextCreateMock.mock.calls[0][0] as {
			data: { metadata: { transcriptSource: string } };
		};
		expect(created.data.metadata.transcriptSource).toBe("recording");
	});

	it("leaves ordinary meetings entirely alone", async () => {
		wireGraphWithNoTranscripts();

		const result = await fetchAndStoreMeetingTranscript({
			...BASE_INPUT,
			joinUrl: ORDINARY_JOIN_URL,
		});

		const tools = mocks.executeMicrosoftTeamsToolMock.mock.calls.map(
			(call) => call[0],
		);
		expect(tools).not.toContain("list_recording_transcripts");
		expect(result.error).toBe("No transcripts available for this meeting.");
	});

	it("names the real cause when the fallback also comes up empty", async () => {
		wireGraphWithNoTranscripts((tool) =>
			tool === "list_recording_transcripts"
				? {
						transcripts: [],
						diagnostic:
							"No recording matches this occurrence — the meeting was most likely not recorded.",
					}
				: undefined,
		);

		const result = await fetchAndStoreMeetingTranscript(BASE_INPUT);

		expect(result.error).toContain("channel meetings");
		expect(result.error).toContain("not recorded");
	});
});

describe("occurrence-level coverage guard", () => {
	it("does not go looking for a recording when the occurrence already has a transcript", async () => {
		mocks.hasTranscriptNearOccurrenceMock.mockResolvedValue(true);
		wireGraphWithNoTranscripts();

		const result = await fetchAndStoreMeetingTranscript(BASE_INPUT);

		const tools = mocks.executeMicrosoftTeamsToolMock.mock.calls.map(
			(call) => call[0],
		);
		// Graph withholds channel transcripts retroactively, so without this the
		// fallback would re-ingest occurrences Graph delivered normally months ago.
		expect(tools).not.toContain("list_recording_transcripts");
		expect(result.transcriptsFetched).toBe(0);
		expect(mocks.projectContextCreateMock).not.toHaveBeenCalled();
	});

	it("asks about coverage using the meeting and its occurrence", async () => {
		mocks.hasTranscriptNearOccurrenceMock.mockResolvedValue(true);
		wireGraphWithNoTranscripts();

		await fetchAndStoreMeetingTranscript(BASE_INPUT);

		expect(mocks.hasTranscriptNearOccurrenceMock).toHaveBeenCalledWith(
			expect.objectContaining({
				projectId: "proj-1",
				meetingId: "meeting-1",
				occurrence: new Date(BASE_INPUT.meetingDate),
			}),
		);
	});

	it("still backfills an occurrence nothing has covered", async () => {
		mocks.hasTranscriptNearOccurrenceMock.mockResolvedValue(false);
		wireGraphWithNoTranscripts((tool) => {
			if (tool === "list_recording_transcripts") {
				return {
					transcripts: [
						{
							id: "stream:rec-20",
							createdDateTime: "2026-08-20T17:10:00Z",
							driveId: "drive-1",
							recordingItemId: "rec-20",
							recordingWebUrl:
								"https://example.sharepoint.com/sites/S/rec20.mp4",
						},
					],
				};
			}
			if (tool === "get_recording_transcript_content") {
				return { entries: [{ speaker: "Alice", text: "Hello." }] };
			}
			return undefined;
		});

		const result = await fetchAndStoreMeetingTranscript(BASE_INPUT);

		expect(result.transcriptsFetched).toBe(1);
	});

	it("leaves ordinary meetings unaffected by the guard", async () => {
		mocks.hasTranscriptNearOccurrenceMock.mockResolvedValue(true);
		wireGraphWithNoTranscripts();

		await fetchAndStoreMeetingTranscript({
			...BASE_INPUT,
			joinUrl: ORDINARY_JOIN_URL,
		});

		// The guard sits inside the channel-meeting branch; an ordinary meeting
		// never reaches it.
		expect(mocks.hasTranscriptNearOccurrenceMock).not.toHaveBeenCalled();
	});
});

describe("describeMissingTranscripts", () => {
	it("passes a real Graph error through untouched", () => {
		expect(
			describeMissingTranscripts({
				graphError: "Transcript access denied for this meeting",
				isChannelMeeting: true,
			}),
		).toBe("Transcript access denied for this meeting");
	});

	it("keeps the plain wording for an ordinary meeting", () => {
		expect(describeMissingTranscripts({ isChannelMeeting: false })).toBe(
			"No transcripts available for this meeting.",
		);
	});

	it("keeps the skipped-classification prefix while explaining a channel meeting", () => {
		const message = describeMissingTranscripts({
			isChannelMeeting: true,
			fallbackDiagnostic: "The channel has no Recordings folder.",
		});
		// The sync workflow classifies skipped-vs-failed by matching this prefix.
		expect(message.startsWith("No transcripts available")).toBe(true);
		expect(message).toContain("channel meetings");
		expect(message).toContain("no Recordings folder");
	});
});

describe("listRecentMeetingInstancesForLinkedUrls", () => {
	const input = {
		userId: "u-1",
		organizationId: "o-1",
		linkedJoinUrls: [CHANNEL_JOIN_URL],
	};

	it("fails loudly when the calendar cannot be read", async () => {
		mocks.executeMicrosoftTeamsToolMock.mockResolvedValue({
			error: "Microsoft Graph API error: 503 Service Unavailable",
		});

		await expect(
			listRecentMeetingInstancesForLinkedUrls(input),
		).rejects.toThrow(/could not read the calendar/i);
	});

	it("rethrows a transport failure instead of reporting an empty calendar", async () => {
		mocks.executeMicrosoftTeamsToolMock.mockRejectedValue(
			new Error("socket hang up"),
		);

		await expect(
			listRecentMeetingInstancesForLinkedUrls(input),
		).rejects.toThrow("socket hang up");
	});

	it("treats a disconnected Microsoft account as a settled state, not a fault", async () => {
		mocks.executeMicrosoftTeamsToolMock.mockResolvedValue({
			error: "Microsoft not connected. Please connect your Microsoft account in Settings > Integrations.",
		});

		await expect(
			listRecentMeetingInstancesForLinkedUrls(input),
		).resolves.toEqual([]);
	});

	it("matches linked meetings when the calendar reads normally", async () => {
		mocks.executeMicrosoftTeamsToolMock.mockResolvedValue({
			meetings: [
				{
					id: "occ-1",
					subject: "Team Sync",
					start: "2026-08-20T16:00:00Z",
					joinUrl: CHANNEL_JOIN_URL,
				},
				{
					id: "occ-2",
					subject: "Unrelated",
					start: "2026-08-20T18:00:00Z",
					joinUrl: "https://teams.microsoft.com/l/meetup-join/other",
				},
			],
		});

		const result = await listRecentMeetingInstancesForLinkedUrls(input);

		expect(result).toHaveLength(1);
		expect(result[0].id).toBe("occ-1");
	});
});

describe("updateMeetingTranscriptSyncLastRunActivity", () => {
	it("stamps a project whose scheduled sync is on", async () => {
		mocks.projectFindUniqueMock.mockResolvedValue({
			meetingTranscriptSyncEnabled: true,
		});

		await updateMeetingTranscriptSyncLastRunActivity({
			projectId: "proj-1",
		});

		expect(mocks.updateLastRunMock).toHaveBeenCalledWith("proj-1");
	});

	it("leaves the timestamp alone when scheduled sync is off", async () => {
		mocks.projectFindUniqueMock.mockResolvedValue({
			meetingTranscriptSyncEnabled: false,
		});

		await updateMeetingTranscriptSyncLastRunActivity({
			projectId: "proj-1",
		});

		expect(mocks.updateLastRunMock).not.toHaveBeenCalled();
	});
});
