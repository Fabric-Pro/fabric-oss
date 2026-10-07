/**
 * A spent ChatGPT plan fails every transcript alike (Fizzy #2770): the
 * activity throws it, so the Daily Brief workflow waits for a reset and runs
 * the step again, instead of storing an empty extraction per transcript. Any
 * other model failure still degrades to an empty extraction, as before.
 */
import { SubscriptionPlanExhaustedError } from "@repo/agent-types/chatgpt-plan-fetch";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ generateObject: vi.fn() }));

vi.mock("@repo/ai", () => ({
	generateObject: mocks.generateObject,
	getAIModelWithMetadata: async () => ({
		model: {},
		metadata: {
			provider: "OPENAI_CHATGPT_PLAN",
			modelString: "gpt-6-astra",
		},
		trackUsage: vi.fn(),
	}),
	getCurrentDateContext: () => "",
}));

vi.mock("@repo/database", () => ({
	computeTodoItemKey: () => "key",
	normalizeItemText: (text: string) => text,
	db: {
		projectMeetingTranscript: {
			findMany: async () => [
				{
					id: "transcript-1",
					meetingSubject: "Planning",
					meetingDate: new Date("2026-10-06T10:00:00Z"),
					speakerNames: [],
					summary: "We planned the release.",
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
		},
		projectContext: { findMany: async () => [] },
	},
}));

vi.mock("@repo/logs", () => ({
	logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock("@temporalio/activity", () => ({ heartbeat: vi.fn() }));
vi.mock("../../../client", () => ({ getTemporalClient: vi.fn() }));
vi.mock("../../../lib/meeting-todo-matcher", () => ({}));

import { extractMeetingInsightsActivity } from "../extract-meeting-insights";

const input = {
	projectId: "project-1",
	organizationId: "org-1",
	userId: "user-1",
	transcriptCuids: ["transcript-1"],
};

beforeEach(() => {
	vi.clearAllMocks();
});

describe("extractMeetingInsightsActivity — spent ChatGPT plan", () => {
	it("throws the spent plan instead of storing an empty extraction", async () => {
		mocks.generateObject.mockRejectedValue(
			new SubscriptionPlanExhaustedError("Every plan is spent.", null),
		);
		await expect(
			extractMeetingInsightsActivity(input),
		).rejects.toBeInstanceOf(SubscriptionPlanExhaustedError);
	});

	it("still degrades any other model failure to an empty extraction", async () => {
		mocks.generateObject.mockRejectedValue(new Error("provider hiccup"));
		await expect(
			extractMeetingInsightsActivity(input),
		).resolves.toMatchObject({
			insights: [
				{
					transcriptCuid: "transcript-1",
					decisions: [],
					actionItems: [],
					openQuestions: [],
				},
			],
		});
	});
});
