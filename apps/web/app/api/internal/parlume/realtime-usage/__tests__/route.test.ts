import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	sessionFindFirst: vi.fn(),
	logUsage: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	db: { parlumeMeetingSession: { findFirst: mocks.sessionFindFirst } },
	logAiUsageAsync: (...args: unknown[]) => mocks.logUsage(...args),
}));

import { POST } from "../route";

const USAGE = {
	inputTextTokens: 1_000,
	inputAudioTokens: 10_000,
	cachedTextTokens: 2_000,
	cachedAudioTokens: 30_000,
	outputTextTokens: 100,
	outputAudioTokens: 400,
};

function usage(overrides: Record<string, unknown> = {}, token = "secret") {
	return new NextRequest(
		"https://fabric.example/api/internal/parlume/realtime-usage",
		{
			method: "POST",
			headers: {
				"content-type": "application/json",
				"X-Agent-Service-Token": token,
			},
			body: JSON.stringify({
				sessionId: "session-1",
				botId: "bot-1",
				...USAGE,
				...overrides,
			}),
		},
	);
}

beforeEach(() => {
	vi.resetAllMocks();
	process.env.AGENT_SERVICE_SECRET = "secret";
	mocks.sessionFindFirst.mockResolvedValue({
		id: "session-1",
		userId: "user-1",
		organizationId: "org-1",
		projectId: "project-1",
	});
});

describe("Parlume realtime usage", () => {
	it("records a response on the organization's OpenAI key, priced by modality and cache", async () => {
		const response = await POST(usage());

		expect(response.status).toBe(200);
		expect(mocks.sessionFindFirst).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { id: "session-1", providerBotId: "bot-1" },
			}),
		);
		expect(mocks.logUsage).toHaveBeenCalledTimes(1);
		const row = mocks.logUsage.mock.calls[0]?.[0];
		expect(row).toEqual(
			expect.objectContaining({
				userId: "user-1",
				organizationId: "org-1",
				projectId: "project-1",
				taskType: "AUDIO",
				featureKey: "parlume",
				conversationId: "session-1",
				provider: "OPENAI_DIRECT",
				providerModelId: "gpt-realtime-2.1",
				inputTokens: 43_000,
				cachedInputTokens: 32_000,
				outputTokens: 500,
				totalTokens: 43_500,
				success: true,
			}),
		);
		// $4, $32, $0.40, $0.40, $24 and $64 per 1M tokens.
		const expected =
			(1_000 * 4 +
				10_000 * 32 +
				2_000 * 0.4 +
				30_000 * 0.4 +
				100 * 24 +
				400 * 64) /
			1_000_000;
		expect(row.costUsd).toBeCloseTo(expected, 10);
	});

	it("records a session on the organization's Azure AI Foundry resource against Azure", async () => {
		const response = await POST(usage({ provider: "AZURE_AI_FOUNDRY" }));

		expect(response.status).toBe(200);
		expect(mocks.logUsage.mock.calls[0]?.[0]).toEqual(
			expect.objectContaining({
				provider: "AZURE_AI_FOUNDRY",
				providerModelId: "gpt-realtime-2.1",
			}),
		);
	});

	it("rejects a caller without the service token", async () => {
		const response = await POST(usage({}, "wrong"));
		expect(response.status).toBe(401);
		expect(mocks.logUsage).not.toHaveBeenCalled();
	});

	it("rejects usage that is not whole token counts", async () => {
		const response = await POST(usage({ outputAudioTokens: -1 }));
		expect(response.status).toBe(400);
		expect(mocks.logUsage).not.toHaveBeenCalled();
	});

	it("records nothing for an unknown meeting", async () => {
		mocks.sessionFindFirst.mockResolvedValue(null);
		const response = await POST(usage());
		expect(response.status).toBe(404);
		expect(mocks.logUsage).not.toHaveBeenCalled();
	});
});
