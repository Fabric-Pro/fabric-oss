import { logAiUsageAsync } from "@repo/database";

export const PARLUME_FEATURE_KEY = "parlume";

/**
 * Hosted Attendee bills one credit per bot-hour, at $0.50 for purchases up to
 * $200 and less at volume, from the bot's creation, so the time it waits in a
 * lobby counts; the bridge transcribes, so no provider transcription is added.
 * Priced at the entry rate so spend is never understated. Update it when the
 * plan changes.
 */
export const PARLUME_ATTENDEE_USD_PER_HOUR = 0.5;

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

function elapsedMs(from: Date | null, to: Date): number {
	return from ? Math.max(0, to.getTime() - from.getTime()) : 0;
}

/**
 * Records the meeting provider's bot time, and the live transcription of the
 * streamed audio, as invocation-marker rows: the same shape image generation
 * and transcription use for spend that has no token count. The provider bills
 * a bot from its creation, so bot time runs from the invite (`requestedAt`,
 * just before the bot is created), lobby wait and a bot that never streamed
 * included; transcription runs only from the verified stream (`joinedAt`).
 * Neither row has a request latency. Never throws: usage accounting must not
 * block finalization.
 */
export function recordParlumeMeetingProviderUsage(input: {
	sessionId: string;
	userId: string;
	organizationId: string;
	projectId: string;
	requestedAt: Date;
	joinedAt: Date | null;
	endedAt: Date;
	success: boolean;
}): void {
	const botMs = elapsedMs(input.requestedAt, input.endedAt);
	const streamedMs = elapsedMs(input.joinedAt, input.endedAt);
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
		latencyMs: 0,
		success: input.success,
	} as const;
	logAiUsageAsync({
		...row,
		provider: "CUSTOM",
		providerModelId: "attendee/teams-bot",
		costUsd: (botMs / 3_600_000) * PARLUME_ATTENDEE_USD_PER_HOUR,
	});
	if (streamedMs > 0) {
		logAiUsageAsync({
			...row,
			provider: "CLOUDFLARE_AI",
			providerModelId: "@cf/deepgram/flux",
			costUsd:
				(streamedMs / 60_000) * PARLUME_TRANSCRIPTION_USD_PER_MINUTE,
		});
	}
}
