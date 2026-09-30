import { resolveOpenAiApiKey } from "@repo/ai";
import { logAiUsageAsync } from "@repo/database";
import { z } from "zod";
import { parlumeActivityLog } from "./parlume-log";

const MAX_SPOKEN_CHARS = 800;
const MAX_PCM_BYTES = 6 * 1024 * 1024;
const TTS_MODEL = "gpt-4o-mini-tts";
// 24 kHz, 16-bit, mono: the PCM format requested below.
const PCM_BYTES_PER_SECOND = 24_000 * 2;
// developers.openai.com/api/docs/models/gpt-4o-mini-tts, 2026-09-30: $0.60 per
// 1M text input tokens, $12 per 1M audio output tokens; OpenAI's own estimate
// is ~$0.015 per minute of audio, i.e. 1,250 audio tokens per minute.
const TTS_USD_PER_TEXT_TOKEN = 0.6 / 1_000_000;
const TTS_USD_PER_AUDIO_MINUTE = 0.015;
const TTS_AUDIO_TOKENS_PER_MINUTE = 1_250;

// The speech endpoint reports no token usage, so the row is derived from what
// was sent and what came back; the same marker-row pattern transcription uses.
function recordSpeechUsage(input: {
	sessionId: string;
	userId: string;
	organizationId: string;
	projectId: string;
	textChars: number;
	pcmBytes: number;
	latencyMs: number;
	success: boolean;
	errorMessage?: string;
}): void {
	const textTokens = Math.ceil(input.textChars / 4);
	const audioMinutes = input.pcmBytes / PCM_BYTES_PER_SECOND / 60;
	logAiUsageAsync({
		userId: input.userId,
		organizationId: input.organizationId,
		projectId: input.projectId,
		provider: "OPENAI_DIRECT",
		providerModelId: TTS_MODEL,
		taskType: "AUDIO",
		featureKey: "parlume",
		conversationId: input.sessionId,
		inputTokens: textTokens,
		outputTokens: Math.round(audioMinutes * TTS_AUDIO_TOKENS_PER_MINUTE),
		totalTokens:
			textTokens + Math.round(audioMinutes * TTS_AUDIO_TOKENS_PER_MINUTE),
		costUsd:
			textTokens * TTS_USD_PER_TEXT_TOKEN +
			audioMinutes * TTS_USD_PER_AUDIO_MINUTE,
		latencyMs: input.latencyMs,
		success: input.success,
		errorMessage: input.errorMessage,
	});
}

function bridgeControlUrl(
	sessionId: string,
	action: "speak" | "stop" | "verify-generation",
): string {
	const host = process.env.NEXT_PUBLIC_PARTYKIT_HOST;
	if (!host) {
		throw new Error("Parlume media host is not configured.");
	}
	const base = new URL(
		host.includes("://")
			? host
			: (host.startsWith("localhost") ? "http://" : "https://") + host,
	);
	if (base.protocol !== "https:" && base.hostname !== "localhost") {
		throw new Error("Parlume media host must use HTTPS.");
	}
	base.pathname = `/parties/parlume/${encodeURIComponent(sessionId)}`;
	base.search = `?action=${action}`;
	return base.toString();
}

export async function verifyParlumeVoiceGeneration(input: {
	sessionId: string;
	voiceGeneration: number;
	signal?: AbortSignal;
}): Promise<boolean> {
	const secret = process.env.AGENT_SERVICE_SECRET;
	if (!secret || input.signal?.aborted) {
		return false;
	}
	try {
		const response = await fetch(
			bridgeControlUrl(input.sessionId, "verify-generation"),
			{
				method: "POST",
				headers: {
					Authorization: `Bearer ${secret}`,
					"content-type": "application/json",
				},
				body: JSON.stringify({
					voiceGeneration: input.voiceGeneration,
				}),
				signal: input.signal
					? AbortSignal.any([
							input.signal,
							AbortSignal.timeout(5_000),
						])
					: AbortSignal.timeout(5_000),
			},
		);
		if (!response.ok) {
			return false;
		}
		return z.object({ current: z.boolean() }).parse(await response.json())
			.current;
	} catch {
		return false;
	}
}

export async function speakParlumeResponse(input: {
	sessionId: string;
	userId: string;
	organizationId: string;
	projectId: string;
	response: string;
	voiceGeneration?: number;
	confirmationSpeakerId?: string;
	signal?: AbortSignal;
}): Promise<{ played: boolean; interrupted: boolean; firstAudioAt?: number }> {
	const secret = process.env.AGENT_SERVICE_SECRET;
	if (!secret) {
		throw new Error("Parlume media service secret is not configured.");
	}
	const key = await resolveOpenAiApiKey({
		userId: input.userId,
		organizationId: input.organizationId,
	});
	if (!key) {
		throw new Error("Parlume voice is not configured.");
	}
	const spoken = input.response.slice(0, MAX_SPOKEN_CHARS);
	const startedAt = Date.now();
	const tts = await fetch("https://api.openai.com/v1/audio/speech", {
		method: "POST",
		headers: {
			Authorization: `Bearer ${key}`,
			"content-type": "application/json",
		},
		body: JSON.stringify({
			model: TTS_MODEL,
			voice: "alloy",
			response_format: "pcm",
			input: spoken,
		}),
		signal: input.signal
			? AbortSignal.any([input.signal, AbortSignal.timeout(60_000)])
			: AbortSignal.timeout(60_000),
	});
	if (!tts.ok) {
		recordSpeechUsage({
			...input,
			textChars: spoken.length,
			pcmBytes: 0,
			latencyMs: Date.now() - startedAt,
			success: false,
			errorMessage: `HTTP ${tts.status}`,
		});
		throw new Error(
			`Parlume speech generation failed (HTTP ${tts.status}).`,
		);
	}
	const declaredLength = Number(tts.headers.get("content-length"));
	if (Number.isFinite(declaredLength) && declaredLength > MAX_PCM_BYTES) {
		throw new Error("Parlume speech exceeded the audio limit.");
	}
	if (!tts.body) {
		throw new Error("Parlume speech returned no audio.");
	}
	let bytes = 0;
	const pcm = tts.body.pipeThrough(
		new TransformStream<Uint8Array, Uint8Array>({
			transform(chunk, controller) {
				bytes += chunk.byteLength;
				if (bytes > MAX_PCM_BYTES) {
					throw new Error("Parlume speech exceeded the audio limit.");
				}
				controller.enqueue(chunk);
			},
			flush() {
				if (bytes === 0 || bytes % 2 !== 0) {
					throw new Error(
						"Parlume speech returned invalid PCM audio.",
					);
				}
			},
		}),
	);
	const playbackRequest: RequestInit & { duplex: "half" } = {
		method: "POST",
		headers: {
			Authorization: `Bearer ${secret}`,
			"content-type": "audio/pcm",
			"x-parlume-voice-generation": String(input.voiceGeneration ?? 0),
			...(input.confirmationSpeakerId
				? {
						"x-parlume-confirmation-speaker":
							input.confirmationSpeakerId,
					}
				: {}),
		},
		body: pcm,
		duplex: "half",
		signal: input.signal
			? AbortSignal.any([input.signal, AbortSignal.timeout(90_000)])
			: AbortSignal.timeout(90_000),
	};
	const playback = await fetch(
		bridgeControlUrl(input.sessionId, "speak"),
		playbackRequest,
	);
	// Synthesis is billed whether or not the bridge could play it.
	recordSpeechUsage({
		...input,
		textChars: spoken.length,
		pcmBytes: bytes,
		latencyMs: Date.now() - startedAt,
		success: playback.ok,
		errorMessage: playback.ok ? undefined : `HTTP ${playback.status}`,
	});
	if (!playback.ok) {
		throw new Error(
			`Parlume audio playback failed (HTTP ${playback.status}).`,
		);
	}
	const result = z
		.object({
			played: z.boolean(),
			interrupted: z.boolean().default(false),
			firstAudioAt: z.number().optional(),
		})
		.parse(await playback.json());
	parlumeActivityLog("info", "speech.delivered", {
		sessionId: input.sessionId,
		voiceGeneration: input.voiceGeneration ?? 0,
		textChars: spoken.length,
		pcmBytes: bytes,
		played: result.played,
		interrupted: result.interrupted,
		totalMs: Date.now() - startedAt,
		firstAudioMs: result.firstAudioAt
			? result.firstAudioAt - startedAt
			: null,
	});
	return result;
}

/**
 * The bridge owns durable provider-stop retries. Activities call this only
 * after an active meeting loses its inviter's project access.
 */
export async function requestParlumeMeetingStop(input: {
	sessionId: string;
}): Promise<void> {
	const secret = process.env.AGENT_SERVICE_SECRET;
	if (!secret) {
		throw new Error("Parlume media service secret is not configured.");
	}
	const response = await fetch(bridgeControlUrl(input.sessionId, "stop"), {
		method: "POST",
		headers: { Authorization: `Bearer ${secret}` },
		signal: AbortSignal.timeout(15_000),
	});
	if (!response.ok) {
		throw new Error("Parlume meeting stop request failed.");
	}
}
