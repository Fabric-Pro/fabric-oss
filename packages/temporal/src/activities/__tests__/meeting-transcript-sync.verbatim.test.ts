/**
 * Fizzy #2316 — a long transcript is stored whole.
 *
 * Before this, a transcript over `TRANSCRIPT_SUMMARIZATION_THRESHOLD` had its
 * body replaced by an LLM summary and the original was never written anywhere.
 * These tests pin the three things that changed:
 *
 *   - the stored `content` is the dialogue, however long it is;
 *   - the summary still gets generated, into the row's `summary` column, which
 *     the Meeting Digest and Daily Brief read;
 *   - `wasSummarized` stays false — it now means "the verbatim original was
 *     destroyed", which is only ever true of rows written before this change.
 *
 * Plus the payload guard: the embedding workflow is started WITHOUT the body,
 * so an arbitrarily long transcript cannot push the workflow input past
 * Temporal's payload limit.
 *
 * Mock shape follows `meeting-transcript-sync.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	executeMicrosoftTeamsToolMock: vi.fn(),
	isTranscriptAlreadySyncedMock: vi.fn(),
	createMeetingTranscriptRecordMock: vi.fn(),
	updateLastRunMock: vi.fn(),
	projectContextCreateMock: vi.fn(),
	projectFindUniqueMock: vi.fn(),
	getTemporalClientMock: vi.fn(),
	workflowStartMock: vi.fn(),
	generateTextMock: vi.fn(),
	getAIModelWithMetadataMock: vi.fn(),
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
	updateMeetingTranscriptSyncLastRun: (...a: unknown[]) =>
		mocks.updateLastRunMock(...a),
	getLinkedMeetingJoinUrls: vi.fn(),
}));

vi.mock("@repo/integrations/microsoft", () => ({
	executeMicrosoftTeamsTool: (...a: unknown[]) =>
		mocks.executeMicrosoftTeamsToolMock(...a),
	extractChannelThreadId: () => null,
	isMicrosoftNotConnectedError: () => false,
}));

vi.mock("@repo/ai", () => ({
	generateText: (...a: unknown[]) => mocks.generateTextMock(...a),
	getAIModelWithMetadata: (...a: unknown[]) =>
		mocks.getAIModelWithMetadataMock(...a),
	logModelUsageAsync: vi.fn(),
}));

vi.mock("@repo/ai/lib/output-token-budget", () => ({
	computeScaledOutputTokenBudget: () => 16_384,
}));

vi.mock("@temporalio/activity", () => ({
	heartbeat: () => {},
}));

vi.mock("../../client", () => ({
	getTemporalClient: (...a: unknown[]) => mocks.getTemporalClientMock(...a),
}));

import { fetchAndStoreMeetingTranscript } from "../meeting-transcript-sync";

const BASE_INPUT = {
	projectId: "proj-1",
	linkedMeetingId: "lm-1",
	userId: "u-1",
	organizationId: "o-1",
	joinUrl: "https://teams.microsoft.com/l/meetup-join/xyz",
	meetingSubject: "Discovery call",
	meetingDate: "2026-06-16T10:00:00.000Z",
};

/** Comfortably past the 50,000-character gate once joined. */
const LONG_ENTRY_COUNT = 900;
const LONG_LINE =
	"and then we walked through the integration surface in some detail";

function wireTeamsPath(entryCount: number) {
	mocks.executeMicrosoftTeamsToolMock.mockImplementation(
		async (tool: string) => {
			if (tool === "get_meeting_by_join_url") {
				return {
					meeting: { id: "meeting-1", subject: "Discovery call" },
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
					entries: Array.from({ length: entryCount }, (_, i) => ({
						speaker: i % 2 === 0 ? "Alice" : "Bob",
						text: `${LONG_LINE} (${i})`,
					})),
				};
			}
			return {};
		},
	);
}

function storedContent(): string {
	const call = mocks.projectContextCreateMock.mock.calls[0][0] as {
		data: { content: string };
	};
	return call.data.content;
}

describe("fetchAndStoreMeetingTranscript — verbatim retention (#2316)", () => {
	beforeEach(() => {
		for (const m of Object.values(mocks)) {
			m.mockReset();
		}
		mocks.isTranscriptAlreadySyncedMock.mockResolvedValue(false);
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
		mocks.projectFindUniqueMock.mockResolvedValue({
			meetingTranscriptSyncEnabled: false,
			meetingTranscriptAutoAnalyzeEnabled: false,
		});
		mocks.getAIModelWithMetadataMock.mockResolvedValue({
			model: {},
			metadata: {},
			trackUsage: () => {},
		});
		mocks.generateTextMock.mockResolvedValue({
			text: "- decided to ship it",
			usage: {},
		});
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	it("stores the dialogue itself when the transcript exceeds the threshold", async () => {
		wireTeamsPath(LONG_ENTRY_COUNT);

		const result = await fetchAndStoreMeetingTranscript(BASE_INPUT);
		expect(result.success).toBe(true);

		const content = storedContent();
		// The gate it used to fail.
		expect(content.length).toBeGreaterThan(50_000);
		// Dialogue, not a summary: every speaker line survived.
		expect(content).toContain("Alice: ");
		expect(content).toContain(`${LONG_LINE} (${LONG_ENTRY_COUNT - 1})`);
		expect(content).not.toContain("**Summary:**");
	});

	it("still records the summary beside it, and does not flag the row as summarized", async () => {
		wireTeamsPath(LONG_ENTRY_COUNT);

		await fetchAndStoreMeetingTranscript(BASE_INPUT);

		expect(mocks.generateTextMock).toHaveBeenCalledTimes(1);
		const record = mocks.createMeetingTranscriptRecordMock.mock
			.calls[0][0] as {
			summary?: string;
			wasSummarized: boolean;
			contentLength: number;
		};
		expect(record.summary).toBe("- decided to ship it");
		expect(record.wasSummarized).toBe(false);
		expect(record.contentLength).toBeGreaterThan(50_000);
	});

	it("keeps the transcript out of the embedding workflow's payload", async () => {
		wireTeamsPath(LONG_ENTRY_COUNT);

		await fetchAndStoreMeetingTranscript(BASE_INPUT);

		const embedCall = mocks.workflowStartMock.mock.calls.find(
			(c) => c[0] === "contextEmbeddingWorkflow",
		);
		expect(embedCall).toBeDefined();
		const args = (
			embedCall?.[1] as { args: Array<Record<string, unknown>> }
		).args[0];
		expect(args.contextId).toBe("ctx-1");
		expect(args.content).toBeUndefined();
	});

	it("stores the transcript even when the summary generation fails", async () => {
		wireTeamsPath(LONG_ENTRY_COUNT);
		mocks.generateTextMock.mockRejectedValue(new Error("model down"));

		const result = await fetchAndStoreMeetingTranscript(BASE_INPUT);
		expect(result.success).toBe(true);

		expect(storedContent()).toContain("Alice: ");
		const record = mocks.createMeetingTranscriptRecordMock.mock
			.calls[0][0] as { summary?: string; wasSummarized: boolean };
		expect(record.summary).toBeUndefined();
		expect(record.wasSummarized).toBe(false);
	});

	it("does not summarize a short transcript at all", async () => {
		wireTeamsPath(3);

		await fetchAndStoreMeetingTranscript(BASE_INPUT);

		expect(mocks.generateTextMock).not.toHaveBeenCalled();
		const record = mocks.createMeetingTranscriptRecordMock.mock
			.calls[0][0] as { summary?: string };
		expect(record.summary).toBeUndefined();
	});
});
