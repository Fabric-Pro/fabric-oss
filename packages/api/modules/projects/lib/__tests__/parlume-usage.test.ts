import { AI_USAGE_MODELS_WITHOUT_REQUEST_LATENCY } from "@repo/database/prisma/queries/ai-usage-latency";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ logUsage: vi.fn() }));

vi.mock("@repo/database", () => ({
	logAiUsageAsync: (...args: unknown[]) => mocks.logUsage(...args),
}));

import {
	PARLUME_ATTENDEE_USD_PER_HOUR,
	PARLUME_TRANSCRIPTION_USD_PER_MINUTE,
	recordParlumeMeetingProviderUsage,
	resolveParlumeMeetingEnd,
} from "../parlume-usage";

describe("resolveParlumeMeetingEnd", () => {
	const terminalCallbackAt = new Date("2026-09-30T17:56:35Z");
	const leaveRequestedAt = new Date("2026-09-30T17:55:00Z");
	const captureStoppedAt = new Date("2026-09-30T17:54:00Z");
	const fallback = new Date("2026-09-30T22:41:36Z");

	it("prefers the provider's terminal callback over every approximation", () => {
		expect(
			resolveParlumeMeetingEnd(
				{ terminalCallbackAt, leaveRequestedAt, captureStoppedAt },
				fallback,
			),
		).toBe(terminalCallbackAt);
	});

	it("falls back to the leave request, then the capture stop, then the clock", () => {
		expect(
			resolveParlumeMeetingEnd(
				{
					terminalCallbackAt: null,
					leaveRequestedAt,
					captureStoppedAt,
				},
				fallback,
			),
		).toBe(leaveRequestedAt);
		expect(
			resolveParlumeMeetingEnd(
				{
					terminalCallbackAt: null,
					leaveRequestedAt: null,
					captureStoppedAt,
				},
				fallback,
			),
		).toBe(captureStoppedAt);
		expect(
			resolveParlumeMeetingEnd(
				{
					terminalCallbackAt: null,
					leaveRequestedAt: null,
					captureStoppedAt: null,
				},
				fallback,
			),
		).toBe(fallback);
	});
});

beforeEach(() => {
	mocks.logUsage.mockReset();
});

describe("recordParlumeMeetingProviderUsage", () => {
	const session = {
		sessionId: "session-1",
		userId: "user-1",
		organizationId: "org-1",
		projectId: "project-1",
	};

	it("bills the bot from the invite, lobby included, and transcription from the stream", () => {
		recordParlumeMeetingProviderUsage({
			...session,
			requestedAt: new Date("2026-09-30T16:50:00Z"),
			joinedAt: new Date("2026-09-30T17:00:00Z"),
			endedAt: new Date("2026-09-30T17:30:00Z"),
			success: true,
		});

		expect(mocks.logUsage).toHaveBeenCalledTimes(2);
		expect(mocks.logUsage).toHaveBeenCalledWith({
			userId: "user-1",
			organizationId: "org-1",
			projectId: "project-1",
			provider: "CUSTOM",
			providerModelId: "attendee/teams-bot",
			taskType: "AUDIO",
			featureKey: "parlume",
			conversationId: "session-1",
			inputTokens: 0,
			outputTokens: 0,
			totalTokens: 0,
			costUsd: (40 / 60) * PARLUME_ATTENDEE_USD_PER_HOUR,
			latencyMs: 0,
			success: true,
		});
		expect(mocks.logUsage).toHaveBeenCalledWith(
			expect.objectContaining({
				provider: "CLOUDFLARE_AI",
				providerModelId: "@cf/deepgram/flux",
				featureKey: "parlume",
				conversationId: "session-1",
				costUsd: 30 * PARLUME_TRANSCRIPTION_USD_PER_MINUTE,
				latencyMs: 0,
			}),
		);
	});

	it("bills a bot that waited in the lobby and never streamed, with no transcription", () => {
		recordParlumeMeetingProviderUsage({
			...session,
			requestedAt: new Date("2026-09-30T17:00:00Z"),
			joinedAt: null,
			endedAt: new Date("2026-09-30T17:10:00Z"),
			success: false,
		});

		expect(mocks.logUsage).toHaveBeenCalledTimes(1);
		expect(mocks.logUsage).toHaveBeenCalledWith(
			expect.objectContaining({
				providerModelId: "attendee/teams-bot",
				costUsd: PARLUME_ATTENDEE_USD_PER_HOUR / 6,
				latencyMs: 0,
				success: false,
			}),
		);
	});

	it("files both rows under models the AI usage page keeps out of latency", () => {
		recordParlumeMeetingProviderUsage({
			...session,
			requestedAt: new Date("2026-09-30T17:00:00Z"),
			joinedAt: new Date("2026-09-30T17:01:00Z"),
			endedAt: new Date("2026-09-30T17:30:00Z"),
			success: true,
		});

		for (const [row] of mocks.logUsage.mock.calls) {
			expect(AI_USAGE_MODELS_WITHOUT_REQUEST_LATENCY).toContain(
				row.providerModelId,
			);
		}
	});
});
