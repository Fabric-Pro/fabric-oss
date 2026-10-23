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

function usage(overrides: Record<string, unknown> = {}, token = "secret") {
	return new NextRequest(
		"https://fabric.example/api/internal/parlume/speech-usage",
		{
			method: "POST",
			headers: {
				"content-type": "application/json",
				"X-Agent-Service-Token": token,
			},
			body: JSON.stringify({
				sessionId: "session-1",
				botId: "bot-1",
				sentences: [
					{ chars: 1_000, totalMs: 900 },
					{ chars: 40, totalMs: null },
				],
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

describe("Parlume bridge speech usage", () => {
	it("records each sentence the bridge spoke as Aura usage of the meeting", async () => {
		const response = await POST(usage());

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ recorded: 2 });
		expect(mocks.sessionFindFirst).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { id: "session-1", providerBotId: "bot-1" },
			}),
		);
		expect(mocks.logUsage).toHaveBeenCalledTimes(2);
		expect(mocks.logUsage).toHaveBeenNthCalledWith(1, {
			userId: "user-1",
			organizationId: "org-1",
			projectId: "project-1",
			taskType: "AUDIO",
			featureKey: "parlume",
			conversationId: "session-1",
			provider: "CLOUDFLARE_AI",
			providerModelId: "@cf/deepgram/aura-2-en",
			inputTokens: 0,
			outputTokens: 0,
			totalTokens: 0,
			costUsd: expect.closeTo(0.03, 10),
			latencyMs: 900,
			success: true,
		});
		expect(mocks.logUsage).toHaveBeenNthCalledWith(
			2,
			expect.objectContaining({
				latencyMs: 0,
				costUsd: expect.closeTo(0.0012, 10),
			}),
		);
	});

	it("rejects a caller without the service token", async () => {
		const response = await POST(usage({}, "wrong"));

		expect(response.status).toBe(401);
		expect(mocks.logUsage).not.toHaveBeenCalled();
	});

	it("refuses an unknown session or bot", async () => {
		mocks.sessionFindFirst.mockResolvedValue(null);

		const response = await POST(usage());

		expect(response.status).toBe(404);
		expect(mocks.logUsage).not.toHaveBeenCalled();
	});

	it("refuses usage outside its bounds", async () => {
		for (const sentences of [
			[],
			[{ chars: 0, totalMs: 1 }],
			[{ chars: 1_501, totalMs: 1 }],
			Array.from({ length: 6_001 }, () => ({ chars: 1, totalMs: 1 })),
		]) {
			const response = await POST(usage({ sentences }));
			expect(response.status).toBe(400);
		}
		expect(mocks.logUsage).not.toHaveBeenCalled();
	});
});
