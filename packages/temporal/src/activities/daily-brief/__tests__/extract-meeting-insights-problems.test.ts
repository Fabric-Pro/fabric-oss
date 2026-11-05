/**
 * Problem Log drafts from meetings (Fizzy #2277): the extraction call also
 * returns issues, blockers and risks, and the activity hands them to the
 * never-throwing drafter as PENDING drafts linked to the transcript, in the
 * caller's organization.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	generateText: vi.fn(),
	draftProblemsFromContext: vi.fn(),
	transaction: vi.fn(),
}));

vi.mock("@repo/ai", () => ({
	Output: { object: (spec: unknown) => spec },
	generateText: mocks.generateText,
	getAIModelWithMetadata: async () => ({
		model: {},
		metadata: { provider: "OPENAI", modelString: "example-model" },
		trackUsage: vi.fn(),
	}),
	getCurrentDateContext: () => "",
}));

vi.mock("@repo/database", () => ({
	computeTodoItemKey: () => "key",
	normalizeItemText: (text: string) => text,
	draftProblemsFromContext: mocks.draftProblemsFromContext,
	db: {
		$transaction: mocks.transaction,
		projectMeetingTranscript: {
			findMany: async () => [
				{
					id: "transcript-1",
					meetingSubject: "Weekly sync",
					meetingDate: new Date("2026-10-06T10:00:00Z"),
					speakerNames: [],
					summary: "We are blocked on vendor keys.",
					contextId: null,
					insightsExtractedAt: null,
					insightsVersion: null,
					extractedDecisions: null,
					extractedActionItems: null,
					extractedQuestions: null,
					userId: "user-1",
					organizationId: "org-1",
					actionItems: [],
				},
			],
			update: vi.fn(),
		},
		projectMeetingActionItem: { deleteMany: vi.fn(), createMany: vi.fn() },
		projectContext: { findMany: async () => [] },
	},
}));

vi.mock("@repo/logs", () => ({
	logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock("@temporalio/activity", () => ({ heartbeat: vi.fn() }));
vi.mock("../../../client", () => ({
	getTemporalClient: async () => ({ workflow: { start: vi.fn() } }),
}));
vi.mock("../../../lib/meeting-todo-matcher", () => ({
	MEETING_TODO_MATCHER_TASK_QUEUE: "queue",
	meetingTodoMatcherWorkflowId: (id: string) => `match-${id}`,
}));

import {
	buildExtractionPrompt,
	extractMeetingInsightsActivity,
} from "../extract-meeting-insights";

const input = {
	projectId: "project-1",
	organizationId: "org-1",
	userId: "user-1",
	transcriptCuids: ["transcript-1"],
};

const llmObject = (problems?: unknown) => ({
	output: {
		summary: "- blocked",
		decisions: [],
		actionItems: [],
		openQuestions: [],
		...(problems === undefined ? {} : { problems }),
	},
});

beforeEach(() => {
	vi.clearAllMocks();
	mocks.transaction.mockResolvedValue([]);
	mocks.draftProblemsFromContext.mockResolvedValue(0);
});

describe("extractMeetingInsightsActivity — Problem Log drafts", () => {
	it("asks the model for issues, blockers and risks", () => {
		const prompt = buildExtractionPrompt({
			meetingSubject: "Weekly sync",
			meetingDate: null,
			speakerNames: [],
			transcriptText: "Ann: we are blocked.",
		});
		expect(prompt).toContain("problems");
		expect(prompt).toContain("BLOCKER");
	});

	it("drafts each extracted problem against the transcript, in the caller's organization", async () => {
		mocks.generateText.mockResolvedValue(
			llmObject([
				{
					kind: "BLOCKER",
					text: "Vendor API keys not issued",
					sourceQuote: "still no keys",
				},
				{ kind: "RISK", text: "Launch may slip" },
			]),
		);

		await extractMeetingInsightsActivity(input);

		expect(mocks.draftProblemsFromContext).toHaveBeenCalledWith({
			organizationId: "org-1",
			projectId: "project-1",
			sourceType: "MEETING_TRANSCRIPT",
			sourceId: "transcript-1",
			drafts: [
				expect.objectContaining({
					category: "PROJECT_BLOCKER",
					title: "Vendor API keys not issued",
					sourceQuote: "still no keys",
					metadata: expect.objectContaining({
						meetingSubject: "Weekly sync",
					}),
				}),
				expect.objectContaining({
					category: "PROJECT_RISK",
					title: "Launch may slip",
					sourceQuote: null,
				}),
			],
		});
	});

	it("completes the extraction when the model found no problems", async () => {
		mocks.generateText.mockResolvedValue(llmObject([]));
		const result = await extractMeetingInsightsActivity(input);
		expect(result.extractedCount).toBe(1);
		expect(mocks.draftProblemsFromContext).toHaveBeenCalledWith(
			expect.objectContaining({ drafts: [] }),
		);
	});

	it("drafts nothing when extraction fails", async () => {
		mocks.generateText.mockRejectedValue(new Error("provider hiccup"));
		await extractMeetingInsightsActivity(input);
		expect(mocks.draftProblemsFromContext).not.toHaveBeenCalled();
	});
});
