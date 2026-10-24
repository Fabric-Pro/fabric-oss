import { logAiUsageAsync } from "@repo/database";

export const PARLUME_AURA_MODEL_ID = "@cf/deepgram/aura-2-en";

// Workers AI prices @cf/deepgram/aura-2-en per input character: $0.03 per
// 1,000 characters.
const AURA_USD_PER_CHAR = 0.03 / 1_000;

/**
 * Records one sentence the bridge synthesized with Aura. Aura reports no
 * token usage, so the row is priced from the characters sent.
 */
export function recordParlumeAuraUsage(
	context: {
		sessionId: string;
		userId: string;
		organizationId: string;
		projectId: string;
	},
	sentence: { chars: number; totalMs: number | null },
): void {
	logAiUsageAsync({
		userId: context.userId,
		organizationId: context.organizationId,
		projectId: context.projectId,
		taskType: "AUDIO",
		featureKey: "parlume",
		conversationId: context.sessionId,
		provider: "CLOUDFLARE_AI",
		providerModelId: PARLUME_AURA_MODEL_ID,
		inputTokens: 0,
		outputTokens: 0,
		totalTokens: 0,
		costUsd: sentence.chars * AURA_USD_PER_CHAR,
		latencyMs: sentence.totalMs ?? 0,
		success: true,
	});
}
