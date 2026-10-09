/**
 * A spent or rotated ChatGPT plan through the REAL `analyzeContextAndPropose`
 * catch (Fizzy #2770 A4). For background callers (a `jobType`) the plan's own
 * error goes up unchanged, so the Slack monitor gives its claim back and the
 * meeting workflow's wait sees `SubscriptionPlanExhaustedError` — the
 * classified, cause-less `ApplicationFailure` used to hide both. A person's
 * own analysis (no `jobType`) keeps the classified failure.
 */
import {
	PlanSourceRotatedError,
	SubscriptionPlanExhaustedError,
} from "@repo/agent-types/chatgpt-plan-fetch";
import { ApplicationFailure } from "@temporalio/common";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	generateObject: vi.fn(),
	releaseSlackClaim: vi.fn(),
	releaseMeetingClaim: vi.fn(),
	fetchThread: vi.fn(),
}));

vi.mock("@repo/ai", () => ({
	generateObject: mocks.generateObject,
	getAIModelWithMetadata: async () => ({
		model: { id: "plan-model" },
		metadata: { modelString: "openai-chatgpt-plan:gpt-6-astra" },
		trackUsage: vi.fn(),
	}),
	logModelUsageAsync: vi.fn(),
	experimental_decide: vi.fn(),
	getAIDecisionModelWithMetadata: vi.fn(async () => {
		throw new Error("no decision model");
	}),
}));

vi.mock("@temporalio/activity", async () => ({
	ApplicationFailure: (await import("@temporalio/common")).ApplicationFailure,
	heartbeat: () => {},
	Context: {
		current: () => ({
			info: { workflowExecution: { workflowId: "wf-1" } },
			heartbeat: () => {},
		}),
	},
}));

vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("@repo/database", async (importOriginal) => ({
	...((await importOriginal()) as Record<string, unknown>),
	db: {
		project: {
			findFirst: async () => null,
			findUnique: async () => ({
				meetingTranscriptSyncEnabled: true,
				meetingTranscriptAutoAnalyzeEnabled: true,
			}),
		},
		userStory: { findMany: async () => [] },
		projectContext: { findMany: async () => [] },
	},
	tenantWhere: () => ({ organizationId: "org-1" }),
	getBoundPromptForAgent: async () => null,
	TERMINAL_DRAFTING_STAGES: ["CLOSED", "DECLINED"],
	getLinkedSlackChannelsForMonitor: async () => [
		{
			id: "lcs1",
			channelId: "C1",
			slackTeamId: "T1",
			channelName: "engineering",
			teamName: "Eng",
			channelWebUrl: "https://slack.example.com/archives/C1",
		},
	],
	claimSlackMessageForAnalysis: async () => true,
	releaseSlackMessageClaim: mocks.releaseSlackClaim,
	claimMeetingTranscriptForAnalysis: async () => ({ claimed: true }),
	releaseMeetingTranscriptAnalysisClaim: mocks.releaseMeetingClaim,
}));

vi.mock("../project-backlog-cache", () => ({
	getCachedProjectBacklog: async () => ({ stories: [] }),
}));

vi.mock(
	"../../slack-channel-monitor/fetch-thread-context",
	async (importOriginal) => ({
		...((await importOriginal()) as Record<string, unknown>),
		fetchSlackThreadContextActivity: mocks.fetchThread,
	}),
);

import { analyzeSlackThreadActivity } from "../../slack-channel-monitor/analyze-slack-thread";
import { analyzeContextAndPropose } from "../analyze-context";
import { autoAnalyzeMeetingTranscriptActivity } from "../auto-analyze-meeting-transcript";

/** How the AI SDK hands a provider error back: a RetryError around it. */
const retryErrorAround = (leaf: Error) =>
	Object.assign(new Error("Failed after 1 attempt."), {
		name: "AI_RetryError",
		lastError: leaf,
		errors: [leaf],
	});

const ANALYZE_INPUT = {
	projectId: "proj-1",
	userId: "user-1",
	organizationId: "org-1",
	fetchedContext: { slackMessages: "U1: the export button does nothing" },
	existingBacklog: { stories: [] },
	userPrompt: "Analyze",
	allowEpics: false,
	allowUpdates: false,
};

beforeEach(() => {
	vi.clearAllMocks();
	mocks.fetchThread.mockResolvedValue({
		messages: [
			{
				ts: "1700000000.000100",
				sender: "U1",
				content: "the export button does nothing",
				createdAt: "2026-05-23T10:00:00.000Z",
				threadTs: "1700000000.000100",
			},
		],
		truncated: false,
		pendingAttachments: [],
		attachmentWarnings: [],
	});
});

describe("analyzeContextAndPropose — a ChatGPT plan refusal", () => {
	it.each([
		[
			"spent",
			() => new SubscriptionPlanExhaustedError("No usage left", null),
		],
		["rotated", () => new PlanSourceRotatedError()],
	])(
		"hands a background caller the %s plan's own error",
		async (_label, make) => {
			const leaf = make();
			mocks.generateObject.mockRejectedValue(retryErrorAround(leaf));
			await expect(
				analyzeContextAndPropose({
					...ANALYZE_INPUT,
					jobType: "slack-channel-monitor",
				}),
			).rejects.toBe(leaf);
		},
	);

	it("keeps the classified failure for a person's own analysis", async () => {
		mocks.generateObject.mockRejectedValue(
			retryErrorAround(
				new SubscriptionPlanExhaustedError("No usage left", null),
			),
		);
		const error = await analyzeContextAndPropose(ANALYZE_INPUT).catch(
			(caught: unknown) => caught,
		);
		expect(error).toBeInstanceOf(ApplicationFailure);
		expect(error).not.toBeInstanceOf(SubscriptionPlanExhaustedError);
	});
});

describe("background callers, through the real analyzer", () => {
	it("Slack: gives the thread's claim back on a spent plan", async () => {
		const leaf = new SubscriptionPlanExhaustedError("No usage left", null);
		mocks.generateObject.mockRejectedValue(retryErrorAround(leaf));
		await expect(
			analyzeSlackThreadActivity({
				projectId: "proj-1",
				userId: "user-1",
				organizationId: "org-1",
				channelId: "C1",
				threadRootTs: "1700000000.000100",
			}),
		).rejects.toBe(leaf);
		expect(mocks.releaseSlackClaim).toHaveBeenCalledWith(
			"lcs1",
			"1700000000.000100",
		);
	});

	it("meeting auto-analysis: fails with the type the workflow waits on, claim released", async () => {
		const leaf = new SubscriptionPlanExhaustedError("No usage left", null);
		mocks.generateObject.mockRejectedValue(retryErrorAround(leaf));
		const error = await autoAnalyzeMeetingTranscriptActivity({
			projectId: "proj-1",
			userId: "user-1",
			organizationId: "org-1",
			transcriptRecordId: "tr-rec-1",
			contextId: "ctx-1",
			meetingId: "meeting-1",
			transcriptId: "transcript-1",
			linkedMeetingId: "lm-1",
			meetingSubject: "Planning",
			transcriptText: "Alice: build CSV export.",
		}).catch((caught: unknown) => caught);
		expect(error).toBe(leaf);
		// Temporal names an activity failure after the thrown error's name.
		expect((error as Error).name).toBe("SubscriptionPlanExhaustedError");
		expect(mocks.releaseMeetingClaim).toHaveBeenCalledWith("tr-rec-1");
	});
});
