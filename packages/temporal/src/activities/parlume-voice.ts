import { getAISpeechModel, resolveOpenAiApiKey } from "@repo/ai";
import { logAiUsageAsync } from "@repo/database";
import { generateSpeech } from "ai";
import { z } from "zod";
import { PARLUME_PCM_SAMPLE_RATE, pcmFromWav } from "./parlume-audio";
import { parlumeActivityLog } from "./parlume-log";

const MAX_SPOKEN_CHARS = 800;
const MAX_PCM_BYTES = 6 * 1024 * 1024;
const MAX_CHAT_CHARS = 4_000;
const PCM_BYTES_PER_SECOND = PARLUME_PCM_SAMPLE_RATE * 2;
const DIRECT_TTS_MODEL = "gpt-4o-mini-tts";
// developers.openai.com/api/docs/models/gpt-4o-mini-tts, 2026-09-30: $0.60 per
// 1M text input tokens, $12 per 1M audio output tokens; OpenAI's own estimate
// is ~$0.015 per minute of audio, i.e. 1,250 audio tokens per minute.
const DIRECT_USD_PER_TEXT_TOKEN = 0.6 / 1_000_000;
const DIRECT_USD_PER_AUDIO_MINUTE = 0.015;
const DIRECT_AUDIO_TOKENS_PER_MINUTE = 1_250;
// tts-1 is priced per input character: $15 per 1M characters.
const GATEWAY_USD_PER_CHAR = 15 / 1_000_000;

type SpeechContext = {
	sessionId: string;
	userId: string;
	organizationId: string;
	projectId: string;
};

type SpeechRoute =
	| { kind: "gateway"; modelId: string }
	| { kind: "openai-direct" };

// The speech endpoints report no token usage, so each row is derived from what
// was sent and what came back; the same marker-row pattern transcription uses.
function recordSpeechUsage(
	context: SpeechContext,
	route: SpeechRoute,
	outcome: {
		textChars: number;
		pcmBytes: number;
		latencyMs: number;
		success: boolean;
		errorMessage?: string;
	},
): void {
	const audioMinutes = outcome.pcmBytes / PCM_BYTES_PER_SECOND / 60;
	const common = {
		userId: context.userId,
		organizationId: context.organizationId,
		projectId: context.projectId,
		taskType: "AUDIO" as const,
		featureKey: "parlume",
		conversationId: context.sessionId,
		latencyMs: outcome.latencyMs,
		success: outcome.success,
		errorMessage: outcome.errorMessage,
	};
	if (route.kind === "gateway") {
		logAiUsageAsync({
			...common,
			provider: "VERCEL_GATEWAY",
			providerModelId: route.modelId,
			inputTokens: 0,
			outputTokens: 0,
			totalTokens: 0,
			costUsd: outcome.textChars * GATEWAY_USD_PER_CHAR,
		});
		return;
	}
	const textTokens = Math.ceil(outcome.textChars / 4);
	const audioTokens = Math.round(
		audioMinutes * DIRECT_AUDIO_TOKENS_PER_MINUTE,
	);
	logAiUsageAsync({
		...common,
		provider: "OPENAI_DIRECT",
		providerModelId: DIRECT_TTS_MODEL,
		inputTokens: textTokens,
		outputTokens: audioTokens,
		totalTokens: textTokens + audioTokens,
		costUsd:
			textTokens * DIRECT_USD_PER_TEXT_TOKEN +
			audioMinutes * DIRECT_USD_PER_AUDIO_MINUTE,
	});
}

function errorMessage(error: unknown): string {
	return (error instanceof Error ? error.message : String(error)).slice(
		0,
		300,
	);
}

function bridgeControlUrl(
	sessionId: string,
	action: "speak" | "stop" | "verify-generation" | "chat",
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

type SynthesizedSpeech = {
	route: SpeechRoute;
	pcm: ReadableStream<Uint8Array>;
	pcmBytes: () => number;
};

function withSignal(signal: AbortSignal | undefined, ms: number): AbortSignal {
	return signal
		? AbortSignal.any([signal, AbortSignal.timeout(ms)])
		: AbortSignal.timeout(ms);
}

/**
 * Gateway speech: the organization's own AI Gateway credential and billing.
 * Returns the whole clip at once (the gateway does not stream speech), which
 * costs roughly a second before the first word on a one- or two-sentence reply.
 */
async function synthesizeThroughGateway(
	context: SpeechContext,
	spoken: string,
	signal: AbortSignal | undefined,
): Promise<SynthesizedSpeech | null> {
	const speech = await getAISpeechModel({
		userId: context.userId,
		organizationId: context.organizationId,
	});
	if (!speech) {
		return null;
	}
	const route: SpeechRoute = { kind: "gateway", modelId: speech.modelId };
	const startedAt = Date.now();
	try {
		const result = await generateSpeech({
			model: speech.model,
			text: spoken,
			voice: "alloy",
			outputFormat: "wav",
			abortSignal: withSignal(signal, 60_000),
		});
		const pcm = pcmFromWav(result.audio.uint8Array);
		if (pcm.length > MAX_PCM_BYTES) {
			throw new Error("Parlume speech exceeded the audio limit.");
		}
		speech.trackUsage();
		recordSpeechUsage(context, route, {
			textChars: spoken.length,
			pcmBytes: pcm.length,
			latencyMs: Date.now() - startedAt,
			success: true,
		});
		return {
			route,
			pcm: new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(pcm);
					controller.close();
				},
			}),
			pcmBytes: () => pcm.length,
		};
	} catch (error) {
		recordSpeechUsage(context, route, {
			textChars: spoken.length,
			pcmBytes: 0,
			latencyMs: Date.now() - startedAt,
			success: false,
			errorMessage: errorMessage(error),
		});
		throw error;
	}
}

/** Direct OpenAI speech: streams PCM so playback starts before synthesis ends. */
async function synthesizeThroughOpenAi(
	context: SpeechContext,
	spoken: string,
	signal: AbortSignal | undefined,
): Promise<SynthesizedSpeech | null> {
	const key = await resolveOpenAiApiKey({
		userId: context.userId,
		organizationId: context.organizationId,
	});
	if (!key) {
		return null;
	}
	const route: SpeechRoute = { kind: "openai-direct" };
	const startedAt = Date.now();
	const tts = await fetch("https://api.openai.com/v1/audio/speech", {
		method: "POST",
		headers: {
			Authorization: `Bearer ${key}`,
			"content-type": "application/json",
		},
		body: JSON.stringify({
			model: DIRECT_TTS_MODEL,
			voice: "alloy",
			response_format: "pcm",
			input: spoken,
		}),
		signal: withSignal(signal, 60_000),
	});
	if (!tts.ok) {
		recordSpeechUsage(context, route, {
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
				// Recorded once the stream drains: only then is the length known.
				recordSpeechUsage(context, route, {
					textChars: spoken.length,
					pcmBytes: bytes,
					latencyMs: Date.now() - startedAt,
					success: true,
				});
			},
		}),
	);
	return { route, pcm, pcmBytes: () => bytes };
}

/**
 * Gateway first, then the organization's direct OpenAI key. A failure of the
 * preferred route falls through to the next one; the last error is reported.
 */
async function synthesizeSpeech(
	context: SpeechContext,
	spoken: string,
	signal: AbortSignal | undefined,
): Promise<SynthesizedSpeech> {
	let lastError: unknown = null;
	for (const synthesize of [
		synthesizeThroughGateway,
		synthesizeThroughOpenAi,
	]) {
		try {
			const speech = await synthesize(context, spoken, signal);
			if (speech) {
				return speech;
			}
		} catch (error) {
			if (signal?.aborted) {
				throw error;
			}
			lastError = error;
			parlumeActivityLog("warn", "speech.route_failed", {
				sessionId: context.sessionId,
				route:
					synthesize === synthesizeThroughGateway
						? "gateway"
						: "openai-direct",
				error: errorMessage(error),
			});
		}
	}
	throw lastError instanceof Error
		? lastError
		: new Error("Parlume voice is not configured.");
}

export async function speakParlumeResponse(
	input: SpeechContext & {
		response: string;
		voiceGeneration?: number;
		confirmationSpeakerId?: string;
		signal?: AbortSignal;
	},
): Promise<{ played: boolean; interrupted: boolean; firstAudioAt?: number }> {
	const secret = process.env.AGENT_SERVICE_SECRET;
	if (!secret) {
		throw new Error("Parlume media service secret is not configured.");
	}
	const spoken = input.response.slice(0, MAX_SPOKEN_CHARS);
	const startedAt = Date.now();
	const speech = await synthesizeSpeech(input, spoken, input.signal);
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
		body: speech.pcm,
		duplex: "half",
		signal: withSignal(input.signal, 90_000),
	};
	const playback = await fetch(
		bridgeControlUrl(input.sessionId, "speak"),
		playbackRequest,
	);
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
		route: speech.route.kind,
		textChars: spoken.length,
		pcmBytes: speech.pcmBytes(),
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
 * Posts a reply into the meeting chat when it could not be spoken, so the
 * question is still answered. Goes through the bridge, which already holds the
 * session's provider bot id and Fabric's internal route; the meeting
 * provider's key stays in the web app.
 */
export async function postParlumeMeetingChat(input: {
	sessionId: string;
	message: string;
}): Promise<boolean> {
	const secret = process.env.AGENT_SERVICE_SECRET;
	if (!secret) {
		return false;
	}
	try {
		const response = await fetch(
			bridgeControlUrl(input.sessionId, "chat"),
			{
				method: "POST",
				headers: {
					Authorization: `Bearer ${secret}`,
					"content-type": "application/json",
				},
				body: JSON.stringify({
					message: input.message.slice(0, MAX_CHAT_CHARS),
				}),
				signal: AbortSignal.timeout(15_000),
			},
		);
		if (!response.ok) {
			return false;
		}
		return z.object({ sent: z.boolean() }).parse(await response.json())
			.sent;
	} catch {
		return false;
	}
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
