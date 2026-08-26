import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock external dependencies so the module can be loaded without network/DB/node_modules.
// zod is used only in LlmInsightSchema (not in buildExtractionPrompt), so a stub is fine.
vi.mock("zod", () => {
	const schema = { min: () => schema, optional: () => schema };
	const z = {
		object: () => schema,
		array: () => schema,
		string: () => schema,
	};
	return { z, default: z };
});
vi.mock("@repo/ai", () => ({
	generateObject: vi.fn(),
	getAIModelWithMetadata: vi.fn(),
	getCurrentDateContext: () => "Today is 2026-04-23.",
	logModelUsageAsync: vi.fn(),
}));
vi.mock("@repo/database", () => ({
	setAiUsageRecorder: vi.fn(),
	db: {
		projectMeetingTranscript: {
			findMany: vi.fn(),
			update: vi.fn(),
		},
		projectMeetingActionItem: {
			deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
			createMany: vi.fn().mockResolvedValue({ count: 0 }),
		},
		projectContext: {
			findMany: vi.fn(),
		},
		// The activity now writes the transcript update + action-item rows in a
		// transaction. Model it as a sequential run of the batched ops, matching
		// the pattern in audit-log-retention.test.ts.
		$transaction: (ops: unknown[]) =>
			Promise.all(ops as Array<Promise<unknown>>),
	},
}));
vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@temporalio/activity", () => ({
	heartbeat: vi.fn(),
}));

import { generateObject, getAIModelWithMetadata } from "@repo/ai";
import { db } from "@repo/database";
import {
	buildExtractionPrompt,
	extractMeetingInsightsActivity,
	MEETING_INSIGHTS_VERSION,
} from "../src/activities/daily-brief/extract-meeting-insights";

describe("extract-meeting-insights prompt", () => {
	it("includes subject, meeting date, and full transcript text", () => {
		const prompt = buildExtractionPrompt({
			meetingSubject: "Sprint planning",
			meetingDate: new Date("2026-04-20T10:00:00Z"),
			speakerNames: ["Amir", "Jules"],
			transcriptText:
				"Amir: we'll split refund logic. Jules: I'll own the migration.",
		});
		expect(prompt).toContain("Sprint planning");
		expect(prompt).toContain("Amir");
		expect(prompt).toContain("split refund logic");
	});

	it("asks for a meeting summary alongside the three insight arrays", () => {
		const prompt = buildExtractionPrompt({
			meetingSubject: "Sprint planning",
			meetingDate: new Date("2026-04-20T10:00:00Z"),
			speakerNames: ["Amir"],
			transcriptText: "Amir: we'll split refund logic.",
		});
		expect(prompt).toContain("summary");
	});

	it("truncates transcripts above the character cap", () => {
		const long = "a".repeat(80_000);
		const prompt = buildExtractionPrompt({
			meetingSubject: "Long",
			meetingDate: new Date(),
			speakerNames: [],
			transcriptText: long,
		});
		expect(prompt.length).toBeLessThan(70_000);
		expect(prompt).toContain("[truncated");
	});
});

describe("extractMeetingInsightsActivity", () => {
	beforeEach(() => {
		// resetAllMocks clears both call history and queued mockResolvedValueOnce
		// stubs so unconsumed stubs from one test can't leak into the next.
		vi.resetAllMocks();
		vi.mocked(getAIModelWithMetadata).mockResolvedValue({
			model: {} as never,
			metadata: {
				modelString: "test",
				provider: "test",
				selectionSource: "test",
			} as never,
			trackUsage: vi.fn(),
		} as never);
	});

	it("returns cached insights without calling the LLM when cache is valid", async () => {
		vi.mocked(db.projectMeetingTranscript.findMany).mockResolvedValueOnce([
			{
				id: "t1",
				meetingSubject: "Sync",
				meetingDate: new Date("2026-04-20T10:00:00Z"),
				speakerNames: ["Amir"],
				summary: "cached summary",
				contextId: null,
				insightsExtractedAt: new Date("2026-04-21T00:00:00Z"),
				insightsVersion: MEETING_INSIGHTS_VERSION,
				extractedDecisions: [{ text: "Split refunds" }],
				extractedActionItems: [
					{ text: "Draft migration", tentativeOwnerName: "Jules" },
				],
				extractedQuestions: [],
			},
		] as never);
		vi.mocked(db.projectContext.findMany).mockResolvedValueOnce(
			[] as never,
		);

		const result = await extractMeetingInsightsActivity({
			projectId: "p1",
			organizationId: null,
			userId: "u1",
			transcriptCuids: ["t1"],
		});

		expect(result.cachedCount).toBe(1);
		expect(result.extractedCount).toBe(0);
		expect(result.insights[0].decisions).toEqual([
			{ text: "Split refunds" },
		]);
		expect(generateObject).not.toHaveBeenCalled();
		expect(db.projectMeetingTranscript.update).not.toHaveBeenCalled();
	});

	it("calls the LLM and writes the cache on a miss with a populated transcript", async () => {
		vi.mocked(db.projectMeetingTranscript.findMany).mockResolvedValueOnce([
			{
				id: "t2",
				meetingSubject: "Planning",
				meetingDate: new Date("2026-04-22T10:00:00Z"),
				speakerNames: ["Amir"],
				summary: null,
				contextId: "ctx1",
				insightsExtractedAt: null,
				insightsVersion: null,
				extractedDecisions: null,
				extractedActionItems: null,
				extractedQuestions: null,
				userId: "u1",
				organizationId: null,
				actionItems: [],
			},
		] as never);
		vi.mocked(db.projectContext.findMany).mockResolvedValueOnce([
			{ id: "ctx1", content: "Amir: ship F-12 on Friday" },
		] as never);
		vi.mocked(generateObject).mockResolvedValueOnce({
			object: {
				summary: "- Agreed to ship F-12 on Friday",
				decisions: [{ text: "Ship F-12 on Friday" }],
				actionItems: [],
				openQuestions: [],
			},
			usage: { totalTokens: 100 },
		} as never);
		vi.mocked(db.projectMeetingTranscript.update).mockResolvedValueOnce(
			{} as never,
		);

		const result = await extractMeetingInsightsActivity({
			projectId: "p1",
			organizationId: null,
			userId: "u1",
			transcriptCuids: ["t2"],
		});

		expect(result.extractedCount).toBe(1);
		expect(result.cachedCount).toBe(0);
		expect(result.insights[0].decisions).toEqual([
			{ text: "Ship F-12 on Friday" },
		]);
		expect(generateObject).toHaveBeenCalledOnce();
		expect(db.projectMeetingTranscript.update).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { id: "t2" },
				data: expect.objectContaining({
					insightsVersion: MEETING_INSIGHTS_VERSION,
					summary: "- Agreed to ship F-12 on Friday",
				}),
			}),
		);
	});

	it("keeps the stored summary untouched when the LLM returns a blank one", async () => {
		vi.mocked(db.projectMeetingTranscript.findMany).mockResolvedValueOnce([
			{
				id: "t5",
				meetingSubject: "Planning",
				meetingDate: new Date("2026-04-22T10:00:00Z"),
				speakerNames: ["Amir"],
				summary: "existing sync-time summary",
				contextId: "ctx5",
				insightsExtractedAt: null,
				insightsVersion: null,
				extractedDecisions: null,
				extractedActionItems: null,
				extractedQuestions: null,
				userId: "u1",
				organizationId: null,
				actionItems: [],
			},
		] as never);
		vi.mocked(db.projectContext.findMany).mockResolvedValueOnce([
			{ id: "ctx5", content: "Amir: status only" },
		] as never);
		vi.mocked(generateObject).mockResolvedValueOnce({
			object: {
				summary: "   ",
				decisions: [],
				actionItems: [],
				openQuestions: [],
			},
			usage: { totalTokens: 50 },
		} as never);
		vi.mocked(db.projectMeetingTranscript.update).mockResolvedValueOnce(
			{} as never,
		);

		await extractMeetingInsightsActivity({
			projectId: "p1",
			organizationId: null,
			userId: "u1",
			transcriptCuids: ["t5"],
		});

		const updateArg = vi.mocked(db.projectMeetingTranscript.update).mock
			.calls[0][0] as { data: Record<string, unknown> };
		expect("summary" in updateArg.data).toBe(false);
	});

	it("does not overwrite the summary when the stored summary was the text source", async () => {
		vi.mocked(db.projectMeetingTranscript.findMany).mockResolvedValueOnce([
			{
				id: "t6",
				meetingSubject: "Legacy",
				meetingDate: new Date("2026-04-22T10:00:00Z"),
				speakerNames: ["Amir"],
				summary: "rich legacy summarizer output",
				contextId: null,
				insightsExtractedAt: null,
				insightsVersion: null,
				extractedDecisions: null,
				extractedActionItems: null,
				extractedQuestions: null,
				userId: "u1",
				organizationId: null,
				actionItems: [],
			},
		] as never);
		vi.mocked(db.projectContext.findMany).mockResolvedValueOnce(
			[] as never,
		);
		vi.mocked(generateObject).mockResolvedValueOnce({
			object: {
				summary: "- summary of a summary",
				decisions: [],
				actionItems: [],
				openQuestions: [],
			},
			usage: { totalTokens: 40 },
		} as never);
		vi.mocked(db.projectMeetingTranscript.update).mockResolvedValueOnce(
			{} as never,
		);

		await extractMeetingInsightsActivity({
			projectId: "p1",
			organizationId: null,
			userId: "u1",
			transcriptCuids: ["t6"],
		});

		const updateArg = vi.mocked(db.projectMeetingTranscript.update).mock
			.calls[0][0] as { data: Record<string, unknown> };
		// Overwriting would destroy the only remaining record of the meeting.
		expect("summary" in updateArg.data).toBe(false);
	});

	it("rethrows LLM failures when failOnError is set (on-demand path)", async () => {
		vi.mocked(db.projectMeetingTranscript.findMany).mockResolvedValueOnce([
			{
				id: "t7",
				meetingSubject: "Fail hard",
				meetingDate: new Date(),
				speakerNames: ["Amir"],
				summary: null,
				contextId: "ctx7",
				insightsExtractedAt: null,
				insightsVersion: null,
				extractedDecisions: null,
				extractedActionItems: null,
				extractedQuestions: null,
			},
		] as never);
		vi.mocked(db.projectContext.findMany).mockResolvedValueOnce([
			{ id: "ctx7", content: "content body" },
		] as never);
		vi.mocked(generateObject).mockRejectedValueOnce(new Error("LLM down"));

		await expect(
			extractMeetingInsightsActivity({
				projectId: "p1",
				organizationId: null,
				userId: "u1",
				transcriptCuids: ["t7"],
				failOnError: true,
			}),
		).rejects.toThrow("LLM down");
	});

	it("invalidates prior-version caches so anchors backfill on the next run", () => {
		// Pre-v3 rows carry no anchor fields (sourceQuote/anchorLine); bumping
		// the version is what makes the cache-hit guard treat them as stale so
		// the next run re-extracts them with anchors (#1896).
		expect(MEETING_INSIGHTS_VERSION).toBe(3);
	});

	it("returns empty insights WITHOUT writing cache when transcript has no text", async () => {
		vi.mocked(db.projectMeetingTranscript.findMany).mockResolvedValueOnce([
			{
				id: "t3",
				meetingSubject: "Empty",
				meetingDate: null,
				speakerNames: [],
				summary: null,
				contextId: null,
				insightsExtractedAt: null,
				insightsVersion: null,
				extractedDecisions: null,
				extractedActionItems: null,
				extractedQuestions: null,
			},
		] as never);
		vi.mocked(db.projectContext.findMany).mockResolvedValueOnce(
			[] as never,
		);

		const result = await extractMeetingInsightsActivity({
			projectId: "p1",
			organizationId: null,
			userId: "u1",
			transcriptCuids: ["t3"],
		});

		expect(result.insights[0]).toEqual({
			transcriptCuid: "t3",
			decisions: [],
			actionItems: [],
			openQuestions: [],
		});
		expect(generateObject).not.toHaveBeenCalled();
		// Regression guard: I2 bug was persisting an empty-cache sentinel here.
		expect(db.projectMeetingTranscript.update).not.toHaveBeenCalled();
	});

	it("returns empty insights and continues when the LLM throws", async () => {
		vi.mocked(db.projectMeetingTranscript.findMany).mockResolvedValueOnce([
			{
				id: "t4",
				meetingSubject: "Fail",
				meetingDate: new Date(),
				speakerNames: ["Amir"],
				summary: null,
				contextId: "ctx4",
				insightsExtractedAt: null,
				insightsVersion: null,
				extractedDecisions: null,
				extractedActionItems: null,
				extractedQuestions: null,
			},
		] as never);
		vi.mocked(db.projectContext.findMany).mockResolvedValueOnce([
			{ id: "ctx4", content: "content body" },
		] as never);
		vi.mocked(generateObject).mockRejectedValueOnce(new Error("LLM down"));

		const result = await extractMeetingInsightsActivity({
			projectId: "p1",
			organizationId: null,
			userId: "u1",
			transcriptCuids: ["t4"],
		});

		expect(result.insights[0]).toEqual({
			transcriptCuid: "t4",
			decisions: [],
			actionItems: [],
			openQuestions: [],
		});
		// Activity does NOT fail the whole call on a single-transcript LLM error.
	});
});
