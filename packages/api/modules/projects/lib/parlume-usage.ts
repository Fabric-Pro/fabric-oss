import { logAiUsageAsync } from "@repo/database";

export const PARLUME_FEATURE_KEY = "parlume";

/**
 * Meeting BaaS bills bot time in tokens: 1.00/hour recording, +0.25 Gladia
 * transcription, +0.10 per streaming direction (Parlume uses both), so 1.45
 * tokens per meeting hour. Priced at the smallest paid pack (Boost, $0.50 per
 * token) from meetingbaas.com/en/pricing on 2026-09-30. Update both numbers
 * together when the plan changes.
 */
export const PARLUME_MEETING_BAAS_USD_PER_HOUR = 1.45 * 0.5;

/**
 * Records the meeting provider's bot time as an invocation-marker row, the
 * same shape image generation and transcription use for spend that has no
 * token count. Never throws: usage accounting must not block finalization.
 */
export function recordParlumeMeetingProviderUsage(input: {
	sessionId: string;
	userId: string;
	organizationId: string;
	projectId: string;
	joinedAt: Date | null;
	endedAt: Date;
	success: boolean;
}): void {
	const durationMs = input.joinedAt
		? Math.max(0, input.endedAt.getTime() - input.joinedAt.getTime())
		: 0;
	logAiUsageAsync({
		userId: input.userId,
		organizationId: input.organizationId,
		projectId: input.projectId,
		provider: "CUSTOM",
		providerModelId: "meeting-baas/teams-bot",
		taskType: "AUDIO",
		featureKey: PARLUME_FEATURE_KEY,
		conversationId: input.sessionId,
		inputTokens: 0,
		outputTokens: 0,
		totalTokens: 0,
		costUsd: (durationMs / 3_600_000) * PARLUME_MEETING_BAAS_USD_PER_HOUR,
		latencyMs: durationMs,
		success: input.success,
	});
}
