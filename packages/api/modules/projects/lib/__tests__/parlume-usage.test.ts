import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ logUsage: vi.fn() }));

vi.mock("@repo/database", () => ({
	logAiUsageAsync: (...args: unknown[]) => mocks.logUsage(...args),
}));

import {
	PARLUME_MEETING_BAAS_USD_PER_HOUR,
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
	it("prices bot time and its transcription, filed under the session", () => {
		recordParlumeMeetingProviderUsage({
			sessionId: "session-1",
			userId: "user-1",
			organizationId: "org-1",
			projectId: "project-1",
			joinedAt: new Date("2026-09-30T17:00:00Z"),
			endedAt: new Date("2026-09-30T17:30:00Z"),
			success: true,
		});

		expect(mocks.logUsage).toHaveBeenCalledWith({
			userId: "user-1",
			organizationId: "org-1",
			projectId: "project-1",
			provider: "CUSTOM",
			providerModelId: "meeting-baas/teams-bot",
			taskType: "AUDIO",
			featureKey: "parlume",
			conversationId: "session-1",
			inputTokens: 0,
			outputTokens: 0,
			totalTokens: 0,
			costUsd: PARLUME_MEETING_BAAS_USD_PER_HOUR / 2,
			latencyMs: 30 * 60 * 1000,
			success: true,
		});
		expect(mocks.logUsage).toHaveBeenCalledWith(
			expect.objectContaining({
				provider: "CLOUDFLARE_AI",
				providerModelId: "@cf/deepgram/flux",
				featureKey: "parlume",
				conversationId: "session-1",
				costUsd: 30 * PARLUME_TRANSCRIPTION_USD_PER_MINUTE,
			}),
		);
	});

	it("records a bot that never joined at zero cost", () => {
		recordParlumeMeetingProviderUsage({
			sessionId: "session-1",
			userId: "user-1",
			organizationId: "org-1",
			projectId: "project-1",
			joinedAt: null,
			endedAt: new Date("2026-09-30T17:30:00Z"),
			success: false,
		});

		expect(mocks.logUsage).toHaveBeenCalledTimes(1);
		expect(mocks.logUsage).toHaveBeenCalledWith(
			expect.objectContaining({
				costUsd: 0,
				latencyMs: 0,
				success: false,
			}),
		);
	});
});
