import { logAiUsageAsync } from "@repo/database";

/** Parlume's realtime voice model, on the organization's own OpenAI key. */
export const PARLUME_REALTIME_MODEL = "gpt-realtime-2.1";

// developers.openai.com, 2026-10-23, per 1M tokens: audio $32 input, $0.40
// cached input, $64 output; text $4 input, $0.40 cached input, $24 output.
const USD_PER_TOKEN = {
	inputText: 4 / 1_000_000,
	cachedText: 0.4 / 1_000_000,
	inputAudio: 32 / 1_000_000,
	cachedAudio: 0.4 / 1_000_000,
	outputText: 24 / 1_000_000,
	outputAudio: 64 / 1_000_000,
} as const;

/**
 * One realtime response's tokens, as the bridge read them from `response.done`.
 * Input counts exclude the cached tokens, which are counted on their own.
 */
export interface ParlumeRealtimeUsage {
	inputTextTokens: number;
	inputAudioTokens: number;
	cachedTextTokens: number;
	cachedAudioTokens: number;
	outputTextTokens: number;
	outputAudioTokens: number;
}

export function parlumeRealtimeCostUsd(usage: ParlumeRealtimeUsage): number {
	return (
		usage.inputTextTokens * USD_PER_TOKEN.inputText +
		usage.cachedTextTokens * USD_PER_TOKEN.cachedText +
		usage.inputAudioTokens * USD_PER_TOKEN.inputAudio +
		usage.cachedAudioTokens * USD_PER_TOKEN.cachedAudio +
		usage.outputTextTokens * USD_PER_TOKEN.outputText +
		usage.outputAudioTokens * USD_PER_TOKEN.outputAudio
	);
}

/**
 * Records one realtime response. The meeting's audio streams into the session
 * all the time, but OpenAI bills it only as the input of a response, so the
 * response's own usage is the whole bill and nothing else is recorded.
 */
export function recordParlumeRealtimeUsage(
	context: {
		sessionId: string;
		userId: string;
		organizationId: string;
		projectId: string;
	},
	usage: ParlumeRealtimeUsage,
): void {
	const cached = usage.cachedTextTokens + usage.cachedAudioTokens;
	const input = usage.inputTextTokens + usage.inputAudioTokens + cached;
	const output = usage.outputTextTokens + usage.outputAudioTokens;
	logAiUsageAsync({
		userId: context.userId,
		organizationId: context.organizationId,
		projectId: context.projectId,
		taskType: "AUDIO",
		featureKey: "parlume",
		conversationId: context.sessionId,
		provider: "OPENAI_DIRECT",
		providerModelId: PARLUME_REALTIME_MODEL,
		inputTokens: input,
		outputTokens: output,
		totalTokens: input + output,
		cachedInputTokens: cached,
		costUsd: parlumeRealtimeCostUsd(usage),
		latencyMs: 0,
		success: true,
	});
}
