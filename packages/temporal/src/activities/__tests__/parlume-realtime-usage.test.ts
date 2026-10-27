import { AI_USAGE_MODELS_WITHOUT_REQUEST_LATENCY } from "@repo/database/prisma/queries/ai-usage-latency";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ logUsage: vi.fn() }));

vi.mock("@repo/database", () => ({
	logAiUsageAsync: (...args: unknown[]) => mocks.logUsage(...args),
}));

import {
	type ParlumeRealtimeUsage,
	parlumeRealtimeCostUsd,
	recordParlumeRealtimeUsage,
} from "../parlume-realtime-usage";

const usage: ParlumeRealtimeUsage = {
	inputTextTokens: 1_000,
	inputAudioTokens: 36_000,
	cachedTextTokens: 500,
	cachedAudioTokens: 20_000,
	outputTextTokens: 200,
	outputAudioTokens: 3_000,
};

const context = {
	sessionId: "session-1",
	userId: "user-1",
	organizationId: "org-1",
	projectId: "project-1",
};

beforeEach(() => {
	mocks.logUsage.mockReset();
});

describe("recordParlumeRealtimeUsage", () => {
	it("prices a response at the list rates, whichever host served it", () => {
		recordParlumeRealtimeUsage(
			{ ...context, provider: "OPENAI_DIRECT" },
			usage,
		);
		recordParlumeRealtimeUsage(
			{ ...context, provider: "AZURE_AI_FOUNDRY" },
			usage,
		);

		const [[openAi], [azure]] = mocks.logUsage.mock.calls;
		expect(openAi.costUsd).toBeCloseTo(
			(1_000 * 4 +
				500 * 0.4 +
				36_000 * 32 +
				20_000 * 0.4 +
				200 * 24 +
				3_000 * 64) /
				1_000_000,
			10,
		);
		expect(azure.costUsd).toBe(openAi.costUsd);
		expect(azure.provider).toBe("AZURE_AI_FOUNDRY");
		expect(parlumeRealtimeCostUsd(usage)).toBe(openAi.costUsd);
	});

	it("files the row under a model the AI usage page keeps out of latency", () => {
		recordParlumeRealtimeUsage(
			{ ...context, provider: "OPENAI_DIRECT" },
			usage,
		);

		const [[row]] = mocks.logUsage.mock.calls;
		expect(row).toMatchObject({
			featureKey: "parlume",
			conversationId: "session-1",
			inputTokens: 57_500,
			outputTokens: 3_200,
			cachedInputTokens: 20_500,
			latencyMs: 0,
		});
		expect(AI_USAGE_MODELS_WITHOUT_REQUEST_LATENCY).toContain(
			row.providerModelId,
		);
	});
});
