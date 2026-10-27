import {
	type AiFeatureKey,
	AUDIO_PROVIDER_REQUIRED,
	resolveOpenAiApiKey,
} from "@repo/ai";
import { AI_CALL_PURPOSES } from "@repo/ai/lib/call-purpose";
import {
	currentAiCallPurpose,
	runWithAiCallPurpose,
} from "@repo/ai/lib/call-purpose-context";
import { logAiUsageAsync } from "@repo/database";
import {
	guardDispatch,
	throwIfDispatchStopped,
} from "@repo/utils/dispatch-guard";
import {
	type SecondaryUsageInput,
	secondaryUsageFields,
} from "../workflows/orchestrator/usage-attribution";

const TTS_MODEL = "tts-1";
const TTS_MAX_CHARS = 4096;
// tts-1 is priced per input character: $15 per 1M characters.
const TTS_USD_PER_CHAR = 15 / 1_000_000;
const TTS_FEATURE_KEY = "text-to-speech" satisfies AiFeatureKey;

export interface TextToSpeechRequest extends SecondaryUsageInput {
	userId: string;
	organizationId?: string | null;
	text: string;
	voice: string;
	speed: number;
}

export type TextToSpeechResult =
	| { ok: true; audio: Buffer }
	| { ok: false; error: string };

/**
 * Speech for the `fabric_text_to_speech` tool, on the tenant's own OpenAI key
 * only. Without one the request is refused with a message naming the remedy;
 * Fabric's own key is never used. Each request that reaches OpenAI writes an
 * `AiUsageLog` row; the speech endpoint reports no tokens, so the row carries
 * the per-character cost instead.
 */
export function synthesizeToolSpeech(
	...args: Parameters<typeof synthesizeToolSpeechInternal>
): ReturnType<typeof synthesizeToolSpeechInternal> {
	return runWithAiCallPurpose(AI_CALL_PURPOSES.speechGeneration, () =>
		synthesizeToolSpeechInternal(...args),
	);
}

async function synthesizeToolSpeechInternal(
	request: TextToSpeechRequest,
): Promise<TextToSpeechResult> {
	const apiKey = await resolveOpenAiApiKey({
		userId: request.userId,
		organizationId: request.organizationId,
	});
	if (!apiKey) {
		return { ok: false, error: AUDIO_PROVIDER_REQUIRED.textToSpeech };
	}

	const input = request.text.substring(0, TTS_MAX_CHARS);
	const startedAt = Date.now();
	// Built outside the model factory, so in a chat turn the request is
	// checked against the turn record here and sent with the guard's abort
	// signal; the latched-stop check is the last thing before the send.
	// Outside a turn both are no-ops.
	const signal = await guardDispatch();
	throwIfDispatchStopped();
	const response = await fetch("https://api.openai.com/v1/audio/speech", {
		method: "POST",
		signal,
		headers: {
			Authorization: `Bearer ${apiKey}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			model: TTS_MODEL,
			input,
			voice: request.voice,
			speed: Math.min(4.0, Math.max(0.25, request.speed)),
			response_format: "mp3",
		}),
	});

	if (!response.ok) {
		const error = `TTS API error ${response.status}: ${await response.text()}`;
		recordSpeechUsage(request, {
			chars: input.length,
			latencyMs: Date.now() - startedAt,
			error,
		});
		return { ok: false, error };
	}

	const audio = Buffer.from(await response.arrayBuffer());
	recordSpeechUsage(request, {
		chars: input.length,
		latencyMs: Date.now() - startedAt,
	});
	return { ok: true, audio };
}

function recordSpeechUsage(
	request: TextToSpeechRequest,
	outcome: { chars: number; latencyMs: number; error?: string },
): void {
	logAiUsageAsync({
		callPurpose: currentAiCallPurpose(),
		userId: request.userId,
		organizationId: request.organizationId ?? undefined,
		conversationId: request.usageConversationId,
		...secondaryUsageFields(request),
		provider: "OPENAI_DIRECT",
		providerModelId: TTS_MODEL,
		taskType: "AUDIO",
		featureKey: TTS_FEATURE_KEY,
		inputTokens: 0,
		outputTokens: 0,
		totalTokens: 0,
		costUsd: outcome.error ? 0 : outcome.chars * TTS_USD_PER_CHAR,
		latencyMs: outcome.latencyMs,
		success: !outcome.error,
		errorMessage: outcome.error?.slice(0, 300),
	});
}
