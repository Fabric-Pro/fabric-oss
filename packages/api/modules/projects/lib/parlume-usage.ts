import { logAiUsageAsync } from "@repo/database";

export const PARLUME_FEATURE_KEY = "parlume";

/**
 * Meeting BaaS bills bot time in tokens: 1.00/hour recording, +0.10 per
 * streaming direction (Parlume uses both), so 1.20 tokens per meeting hour;
 * the bridge transcribes, so no provider transcription is added. Priced at the
 * smallest paid pack (Boost, $0.50 per token) from meetingbaas.com/en/pricing
 * on 2026-09-30. Update both numbers together when the plan changes.
 */
export const PARLUME_MEETING_BAAS_USD_PER_HOUR = 1.2 * 0.5;

/**
 * The bridge streams the whole meeting to Deepgram Flux on Workers AI, billed
 * per audio minute over WebSocket (developers.cloudflare.com, 2026-10-02).
 */
export const PARLUME_TRANSCRIPTION_USD_PER_MINUTE = 0.0077;

/**
 * When the bot stopped costing provider time. The provider's terminal callback
 * is exact; a recorded leave request or capture stop approximates it when the
 * callback never came; only a session with neither falls back to the caller's
 * clock (finalization can run hours after the bot left).
 */
export function resolveParlumeMeetingEnd(
	session: {
		terminalCallbackAt: Date | null;
		leaveRequestedAt: Date | null;
		captureStoppedAt: Date | null;
	},
	fallback: Date,
): Date {
	return (
		session.terminalCallbackAt ??
		session.leaveRequestedAt ??
		session.captureStoppedAt ??
		fallback
	);
}

/**
 * Records the meeting provider's bot time, and the live transcription of that
 * time, as invocation-marker rows: the same shape image generation and
 * transcription use for spend that has no token count. Never throws: usage
 * accounting must not block finalization.
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
	const row = {
		userId: input.userId,
		organizationId: input.organizationId,
		projectId: input.projectId,
		taskType: "AUDIO",
		featureKey: PARLUME_FEATURE_KEY,
		conversationId: input.sessionId,
		inputTokens: 0,
		outputTokens: 0,
		totalTokens: 0,
		latencyMs: durationMs,
		success: input.success,
	} as const;
	logAiUsageAsync({
		...row,
		provider: "CUSTOM",
		providerModelId: "meeting-baas/teams-bot",
		costUsd: (durationMs / 3_600_000) * PARLUME_MEETING_BAAS_USD_PER_HOUR,
	});
	if (durationMs > 0) {
		logAiUsageAsync({
			...row,
			provider: "CLOUDFLARE_AI",
			providerModelId: "@cf/deepgram/flux",
			costUsd:
				(durationMs / 60_000) * PARLUME_TRANSCRIPTION_USD_PER_MINUTE,
		});
	}
}
