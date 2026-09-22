/**
 * Unit tests for the auto-analyze ingest hook inside
 * `fetchAndStoreMeetingTranscript`.
 *
 * Covers:
 *   - BOTH flags ON  → `autoAnalyzeMeetingTranscriptWorkflow` is started exactly
 *     once for a brand-new transcript, with the deterministic transcript-keyed
 *     workflowId and reject-duplicates policies.
 *   - either flag OFF → the workflow is NOT started.
 *   - a throw from `client.workflow.start` is SWALLOWED — transcript ingest
 *     still reports success and the loop is not aborted.
 *
 * The Microsoft Teams integration, `@repo/ai`, and the DB layer are mocked so
 * the activity runs without Postgres / Graph / an LLM. Mock shape follows
 * `backlog-apply-watchdog-activities.test.ts` (`getTemporalClient` from
 * `../../client`).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

// `extractChannelThreadId` and `isMicrosoftNotConnectedError` are pure string
// predicates — mock them with the real behaviour rather than a stub, so these
// tests keep exercising the ordinary-meeting path they were written for.
vi.mock("@repo/integrations/microsoft", () => ({
	executeMicrosoftTeamsTool: (...a: unknown[]) =>
		mocks.executeMicrosoftTeamsToolMock(...a),
	extractChannelThreadId: (joinUrl: string) =>
		decodeURIComponent(joinUrl).includes("@thread.tacv2")
			? "19:thread@thread.tacv2"
			: null,
	isMicrosoftNotConnectedError: (message: string) =>
		message.includes("Microsoft not connected") ||
		message.includes("Microsoft account in Settings"),
}));

// `@repo/ai` is imported at module top; stub it so the heavy transitive chain
// (payments, model resolution) is not loaded. Summarization is never reached
// in these tests (the transcript is well under the 50K threshold).
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
import { fetchAndStoreMeetingTranscript } from "../meeting-transcript-sync";

const BASE_INPUT = {
	projectId: "proj-1",
	linkedMeetingId: "lm-1",
	userId: "u-1",
	organizationId: "o-1",
	joinUrl: "https://teams.microsoft.com/l/meetup-join/xyz",
	meetingSubject: "Sprint planning",
	meetingDate: "2026-06-16T10:00:00.000Z",
};

/**
 * Wire the Teams tool sequence for one new transcript:
 *   get_meeting_by_join_url → list_meeting_transcripts → get_meeting_transcript_content
 */
function wireHappyTeamsPath() {
	mocks.executeMicrosoftTeamsToolMock.mockImplementation(
		async (tool: string) => {
			if (tool === "get_meeting_by_join_url") {
				return {
					meeting: { id: "meeting-1", subject: "Sprint planning" },
				};
			}
			if (tool === "list_meeting_transcripts") {
				return {
					transcripts: [
						{
							id: "transcript-1",
							createdDateTime: "2026-06-16T10:30:00.000Z",
						},
					],
					count: 1,
				};
			}
			if (tool === "get_meeting_transcript_content") {
				return {
					entries: [
						{
							speaker: "Alice",
							text: "We should build a CSV export feature.",
						},
						{ speaker: "Bob", text: "Agreed, file it." },
					],
				};
			}
			return {};
		},
	);
}

describe("fetchAndStoreMeetingTranscript — auto-analyze ingest hook", () => {
	beforeEach(() => {
		for (const m of Object.values(mocks)) {
			m.mockReset();
		}
		wireHappyTeamsPath();
		mocks.isTranscriptAlreadySyncedMock.mockResolvedValue(false);
		mocks.hasTranscriptNearOccurrenceMock.mockResolvedValue(false);
		mocks.projectContextCreateMock.mockResolvedValue({ id: "ctx-1" });
		mocks.createMeetingTranscriptRecordMock.mockResolvedValue({
			id: "tr-rec-1",
		});
		mocks.workflowStartMock.mockResolvedValue({ workflowId: "wf-1" });
		mocks.getTemporalClientMock.mockResolvedValue({
			workflow: {
				start: (...a: unknown[]) => mocks.workflowStartMock(...a),
			},
		});
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	it("starts autoAnalyzeMeetingTranscriptWorkflow once when BOTH flags are ON (AC2)", async () => {
		mocks.projectFindUniqueMock.mockResolvedValue({
			meetingTranscriptSyncEnabled: true,
			meetingTranscriptAutoAnalyzeEnabled: true,
		});

		const result = await fetchAndStoreMeetingTranscript(BASE_INPUT);

		expect(result.success).toBe(true);
		expect(result.transcriptsFetched).toBe(1);

		// The ONLY workflow.start in this activity (embedding uses its own
		// string name) we assert on is the auto-analyze one.
		const autoCalls = mocks.workflowStartMock.mock.calls.filter(
			(c) => c[0] === "autoAnalyzeMeetingTranscriptWorkflow",
		);
		expect(autoCalls).toHaveLength(1);

		const opts = autoCalls[0][1] as {
			taskQueue: string;
			workflowId: string;
			workflowIdReusePolicy: string;
			workflowIdConflictPolicy: string;
			args: Array<Record<string, unknown>>;
		};
		expect(opts.taskQueue).toBe("ai-chat");
		expect(opts.workflowId).toBe(
			"auto-analyze-meeting-transcript:tr-rec-1",
		);
		expect(opts.workflowIdReusePolicy).toBe("REJECT_DUPLICATE");
		expect(opts.workflowIdConflictPolicy).toBe("FAIL");
		expect(opts.args[0]).toMatchObject({
			projectId: "proj-1",
			userId: "u-1",
			organizationId: "o-1",
			transcriptRecordId: "tr-rec-1",
			contextId: "ctx-1",
			meetingId: "meeting-1",
			transcriptId: "transcript-1",
			linkedMeetingId: "lm-1",
			meetingSubject: "Sprint planning",
		});
		expect(typeof opts.args[0].transcriptText).toBe("string");
		expect((opts.args[0].transcriptText as string).length).toBeGreaterThan(
			0,
		);
	});

	it("does NOT start the workflow when auto-analyze is OFF (AC1)", async () => {
		mocks.projectFindUniqueMock.mockResolvedValue({
			meetingTranscriptSyncEnabled: true,
			meetingTranscriptAutoAnalyzeEnabled: false,
		});

		const result = await fetchAndStoreMeetingTranscript(BASE_INPUT);

		expect(result.success).toBe(true);
		const autoCalls = mocks.workflowStartMock.mock.calls.filter(
			(c) => c[0] === "autoAnalyzeMeetingTranscriptWorkflow",
		);
		expect(autoCalls).toHaveLength(0);
	});

	it("does NOT start the workflow when sync is OFF (AC1)", async () => {
		mocks.projectFindUniqueMock.mockResolvedValue({
			meetingTranscriptSyncEnabled: false,
			meetingTranscriptAutoAnalyzeEnabled: true,
		});

		const result = await fetchAndStoreMeetingTranscript(BASE_INPUT);

		expect(result.success).toBe(true);
		const autoCalls = mocks.workflowStartMock.mock.calls.filter(
			(c) => c[0] === "autoAnalyzeMeetingTranscriptWorkflow",
		);
		expect(autoCalls).toHaveLength(0);
	});

	it("swallows a workflow.start throw — ingest still reports success (AC6)", async () => {
		mocks.projectFindUniqueMock.mockResolvedValue({
			meetingTranscriptSyncEnabled: true,
			meetingTranscriptAutoAnalyzeEnabled: true,
		});
		mocks.workflowStartMock.mockImplementation(async (name: string) => {
			if (name === "autoAnalyzeMeetingTranscriptWorkflow") {
				throw new Error("temporal offline");
			}
			return { workflowId: "wf-embed" };
		});

		const result = await fetchAndStoreMeetingTranscript(BASE_INPUT);

		// The throw must NOT bubble: ingest reports success and the transcript
		// was still created.
		expect(result.success).toBe(true);
		expect(result.transcriptsFetched).toBe(1);
		expect(result.transcriptRecordId).toBe("tr-rec-1");
		expect(mocks.createMeetingTranscriptRecordMock).toHaveBeenCalledTimes(
			1,
		);
	});

	it("starts extractMeetingInsightsOnDemandWorkflow for each new transcript when sync is enabled (even with auto-analyze OFF)", async () => {
		mocks.projectFindUniqueMock.mockResolvedValue({
			meetingTranscriptSyncEnabled: true,
			meetingTranscriptAutoAnalyzeEnabled: false,
		});

		const result = await fetchAndStoreMeetingTranscript(BASE_INPUT);

		expect(result.success).toBe(true);
		expect(result.transcriptsFetched).toBe(1);

		const insightStarts = mocks.workflowStartMock.mock.calls.filter(
			(c) => c[0] === "extractMeetingInsightsOnDemandWorkflow",
		);
		expect(insightStarts).toHaveLength(1);
		expect(insightStarts[0][1]).toMatchObject({
			taskQueue: "project-documents",
			workflowIdReusePolicy: "ALLOW_DUPLICATE",
			workflowIdConflictPolicy: "FAIL",
		});
		expect(insightStarts[0][1].workflowId).toMatch(
			/^meeting-digest-insights:/,
		);
	});

	it("a failed insights-workflow start is non-fatal (transcript still stored)", async () => {
		mocks.projectFindUniqueMock.mockResolvedValue({
			meetingTranscriptSyncEnabled: true,
			meetingTranscriptAutoAnalyzeEnabled: true,
		});
		mocks.workflowStartMock.mockImplementation(async (name: string) => {
			if (name === "extractMeetingInsightsOnDemandWorkflow") {
				throw new Error("temporal offline");
			}
			return { workflowId: "wf-1" };
		});

		const result = await fetchAndStoreMeetingTranscript(BASE_INPUT);

		expect(result.success).toBe(true);
		expect(result.transcriptsFetched).toBe(1);
		expect(result.transcriptRecordId).toBe("tr-rec-1");
		expect(mocks.createMeetingTranscriptRecordMock).toHaveBeenCalledTimes(
			1,
		);
	});
});

/**
 * Graph occasionally reissues a transcript under a new id: same meeting, same
 * occurrence, same content, different `transcriptId`. The id-keyed unique
 * index then lets it through as a brand-new transcript, which stores the
 * occurrence a second time and auto-analyzes it again months after the fact.
 */
describe("fetchAndStoreMeetingTranscript — reissued transcript ids", () => {
	beforeEach(() => {
		for (const m of Object.values(mocks)) {
			m.mockReset();
		}
		wireHappyTeamsPath();
		mocks.isTranscriptAlreadySyncedMock.mockResolvedValue(false);
		mocks.hasTranscriptNearOccurrenceMock.mockResolvedValue(false);
		mocks.projectContextCreateMock.mockResolvedValue({ id: "ctx-1" });
		mocks.createMeetingTranscriptRecordMock.mockResolvedValue({
			id: "tr-rec-1",
		});
		mocks.projectFindUniqueMock.mockResolvedValue({
			meetingTranscriptSyncEnabled: true,
			meetingTranscriptAutoAnalyzeEnabled: true,
		});
		mocks.workflowStartMock.mockResolvedValue({ workflowId: "wf-1" });
		mocks.getTemporalClientMock.mockResolvedValue({
			workflow: {
				start: (...a: unknown[]) => mocks.workflowStartMock(...a),
			},
		});
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	it("skips a transcript whose occurrence this link already covers, even under a new id", async () => {
		mocks.hasTranscriptNearOccurrenceMock.mockResolvedValue(true);

		const result = await fetchAndStoreMeetingTranscript(BASE_INPUT);

		expect(result.transcriptsFetched).toBe(0);
		const tools = mocks.executeMicrosoftTeamsToolMock.mock.calls.map(
			(call) => call[0],
		);
		expect(tools).not.toContain("get_meeting_transcript_content");
		expect(mocks.projectContextCreateMock).not.toHaveBeenCalled();
		expect(mocks.createMeetingTranscriptRecordMock).not.toHaveBeenCalled();
		expect(mocks.workflowStartMock).not.toHaveBeenCalled();
	});

	it("asks about coverage using the link and the transcript's own occurrence", async () => {
		mocks.hasTranscriptNearOccurrenceMock.mockResolvedValue(true);

		await fetchAndStoreMeetingTranscript(BASE_INPUT);

		// The transcript's createdDateTime, not the series-level meetingDate:
		// for a recurring meeting every transcript shares the latter.
		expect(mocks.hasTranscriptNearOccurrenceMock).toHaveBeenCalledWith(
			expect.objectContaining({
				projectId: "proj-1",
				linkedMeetingId: "lm-1",
				occurrence: new Date("2026-06-16T10:30:00.000Z"),
			}),
		);
	});

	it("still stores two transcripts Graph lists together for one occurrence", async () => {
		mocks.executeMicrosoftTeamsToolMock.mockImplementation(
			async (tool: string) => {
				if (tool === "get_meeting_by_join_url") {
					return { meeting: { id: "meeting-1" } };
				}
				if (tool === "list_meeting_transcripts") {
					return {
						transcripts: [
							{
								id: "transcript-1",
								createdDateTime: "2026-06-16T10:30:00.000Z",
							},
							{
								id: "transcript-2",
								createdDateTime: "2026-06-16T10:45:00.000Z",
							},
						],
						count: 2,
					};
				}
				if (tool === "get_meeting_transcript_content") {
					return { entries: [{ speaker: "Alice", text: "Hello." }] };
				}
				return {};
			},
		);
		// Coverage is decided before anything is stored, so the first
		// transcript's row must not make the second look like a reissue.
		mocks.createMeetingTranscriptRecordMock.mockImplementation(async () => {
			mocks.hasTranscriptNearOccurrenceMock.mockResolvedValue(true);
			return { id: "tr-rec-1" };
		});

		const result = await fetchAndStoreMeetingTranscript(BASE_INPUT);

		expect(result.transcriptsFetched).toBe(2);
		expect(mocks.createMeetingTranscriptRecordMock).toHaveBeenCalledTimes(
			2,
		);
	});

	it("falls back to id-only dedupe when Graph gives the transcript no createdDateTime", async () => {
		mocks.executeMicrosoftTeamsToolMock.mockImplementation(
			async (tool: string) => {
				if (tool === "get_meeting_by_join_url") {
					return { meeting: { id: "meeting-1" } };
				}
				if (tool === "list_meeting_transcripts") {
					return { transcripts: [{ id: "transcript-1" }], count: 1 };
				}
				if (tool === "get_meeting_transcript_content") {
					return { entries: [{ speaker: "Alice", text: "Hello." }] };
				}
				return {};
			},
		);
		// Would say "covered" if asked — the series-level meetingDate is
		// shared by every occurrence, so asking would suppress a new one.
		mocks.hasTranscriptNearOccurrenceMock.mockResolvedValue(true);

		const result = await fetchAndStoreMeetingTranscript(BASE_INPUT);

		expect(result.transcriptsFetched).toBe(1);
		expect(mocks.hasTranscriptNearOccurrenceMock).not.toHaveBeenCalled();
	});

	it("does not re-check a transcript recovered from a channel recording", async () => {
		mocks.executeMicrosoftTeamsToolMock.mockImplementation(
			async (tool: string) => {
				if (tool === "get_meeting_by_join_url") {
					return { meeting: { id: "meeting-1" } };
				}
				if (tool === "list_meeting_transcripts") {
					return { transcripts: [], count: 0 };
				}
				if (tool === "list_recording_transcripts") {
					return {
						transcripts: [
							{
								id: "recording-1",
								createdDateTime: "2026-06-16T10:30:00.000Z",
								driveId: "drive-1",
								recordingItemId: "item-1",
								recordingWebUrl: "https://example.com/rec",
							},
						],
					};
				}
				if (tool === "get_recording_transcript_content") {
					return { entries: [{ speaker: "Alice", text: "Hello." }] };
				}
				return {};
			},
		);
		// The fallback's own coverage check (calendar date) says "not
		// covered"; a second look from the recording's timestamp must not
		// happen at all.
		mocks.hasTranscriptNearOccurrenceMock.mockResolvedValue(false);

		const result = await fetchAndStoreMeetingTranscript({
			...BASE_INPUT,
			joinUrl:
				"https://teams.microsoft.com/l/meetup-join/19%3Athread%40thread.tacv2/123",
		});

		expect(result.transcriptsFetched).toBe(1);
		expect(mocks.hasTranscriptNearOccurrenceMock).toHaveBeenCalledTimes(1);
		expect(mocks.hasTranscriptNearOccurrenceMock).toHaveBeenCalledWith(
			expect.objectContaining({
				occurrence: new Date(BASE_INPUT.meetingDate),
			}),
		);
	});

	it("does not ask about coverage for a transcript already stored under its id", async () => {
		mocks.isTranscriptAlreadySyncedMock.mockResolvedValue(true);

		const result = await fetchAndStoreMeetingTranscript(BASE_INPUT);

		expect(result.transcriptsFetched).toBe(0);
		expect(mocks.hasTranscriptNearOccurrenceMock).not.toHaveBeenCalled();
	});
});
