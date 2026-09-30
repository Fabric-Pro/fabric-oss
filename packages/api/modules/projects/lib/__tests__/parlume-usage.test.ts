import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ logUsage: vi.fn() }));

vi.mock("@repo/database", () => ({
	logAiUsageAsync: (...args: unknown[]) => mocks.logUsage(...args),
}));

import {
	PARLUME_MEETING_BAAS_USD_PER_HOUR,
	recordParlumeMeetingProviderUsage,
} from "../parlume-usage";

beforeEach(() => {
	mocks.logUsage.mockReset();
});

describe("recordParlumeMeetingProviderUsage", () => {
	it("prices bot time by the hour and files it under the session", () => {
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

		expect(mocks.logUsage).toHaveBeenCalledWith(
			expect.objectContaining({
				costUsd: 0,
				latencyMs: 0,
				success: false,
			}),
		);
	});
});
