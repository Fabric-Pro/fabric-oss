import {
	AUDIO_PROVIDER_REQUIRED,
	getAISpeechModel,
	resolveOpenAiApiKey,
} from "@repo/ai";
import { logAiUsageAsync } from "@repo/database";
import { generateSpeech } from "ai";
import { z } from "zod";
import { PARLUME_PCM_SAMPLE_RATE, pcmFromWav } from "./parlume-audio";
import { parlumeActivityLog } from "./parlume-log";
import { ReplayableSentences } from "./parlume-spoken-text";
import {
	recordTurnSpeechSentence,
	type SpeechSentenceTiming,
} from "./shared/turn-timing";

export const PARLUME_MAX_SPOKEN_CHARS = 800;
const PARLUME_AURA_MODEL_ID = "@cf/deepgram/aura-2-en";
const NOTHING_TO_SAY = "Parlume had nothing to say.";
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
	action: "speak" | "say" | "stop" | "verify-generation" | "chat",
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

/** Epoch milliseconds at which a clip's first and last bytes arrived; null until they do. */
type ClipArrival = { firstByteAt: number | null; doneAt: number | null };

type SynthesizedSpeech = {
	route: SpeechRoute;
	pcm: ReadableStream<Uint8Array>;
	pcmBytes: () => number;
	arrival: ClipArrival;
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
		const arrivedAt = Date.now();
		return {
			route,
			pcm: new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(pcm);
					controller.close();
				},
			}),
			pcmBytes: () => pcm.length,
			// The gateway returns the whole clip, so its first byte is its last.
			arrival: { firstByteAt: arrivedAt, doneAt: arrivedAt },
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
	const arrival: ClipArrival = { firstByteAt: null, doneAt: null };
	const pcm = tts.body.pipeThrough(
		new TransformStream<Uint8Array, Uint8Array>({
			transform(chunk, controller) {
				arrival.firstByteAt ??= Date.now();
				bytes += chunk.byteLength;
				if (bytes > MAX_PCM_BYTES) {
					throw new Error("Parlume speech exceeded the audio limit.");
				}
				controller.enqueue(chunk);
			},
			flush() {
				arrival.doneAt = Date.now();
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
	return { route, pcm, pcmBytes: () => bytes, arrival };
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
		: new Error(AUDIO_PROVIDER_REQUIRED.parlumeVoice);
}

type SpokenReply = {
	route: SpeechRoute;
	pcm: ReadableStream<Uint8Array>;
	textChars: () => number;
	pcmBytes: () => number;
	/** One entry per sentence synthesized so far, relative to `origin`. */
	sentenceTimings: (origin: number) => SpeechSentenceTiming[];
};

/**
 * Speaks the sentences in order as one PCM stream. The first sentence is
 * synthesized before anything is sent; each later one is synthesized while
 * the one before it plays, so a long answer starts as soon as its first
 * sentence exists.
 */
async function synthesizeSentences(
	context: SpeechContext,
	sentences: AsyncIterable<string>,
	signal: AbortSignal | undefined,
): Promise<SpokenReply> {
	const iterator = sentences[Symbol.asyncIterator]();
	let textChars = 0;
	let pcmBytes = 0;
	const synthesized: Array<{
		chars: number;
		requestedAt: number;
		speech: SynthesizedSpeech;
	}> = [];
	const synthesizeNext = async (): Promise<SynthesizedSpeech | null> => {
		const next = await iterator.next();
		if (next.done) {
			return null;
		}
		textChars += next.value.length;
		// Measured from the moment the sentence exists, so a route that failed
		// before the one that answered is part of the cost.
		const requestedAt = Date.now();
		const speech = await synthesizeSpeech(context, next.value, signal);
		synthesized.push({ chars: next.value.length, requestedAt, speech });
		return speech;
	};
	let current = await synthesizeNext();
	if (!current) {
		throw new Error(NOTHING_TO_SAY);
	}
	const route = current.route;
	let upcoming = synthesizeNext();
	// Awaited when its turn comes; until then a failure must not go unhandled.
	upcoming.catch(() => {});
	let reader = current.pcm.getReader();
	const pcm = new ReadableStream<Uint8Array>({
		async pull(controller) {
			for (;;) {
				const { done, value } = await reader.read();
				if (!done) {
					controller.enqueue(value);
					return;
				}
				pcmBytes += current?.pcmBytes() ?? 0;
				const next = await upcoming;
				if (!next) {
					controller.close();
					return;
				}
				current = next;
				upcoming = synthesizeNext();
				upcoming.catch(() => {});
				reader = next.pcm.getReader();
			}
		},
		async cancel(reason) {
			await reader.cancel(reason);
		},
	});
	return {
		route,
		pcm,
		textChars: () => textChars,
		pcmBytes: () => pcmBytes,
		sentenceTimings: (origin) =>
			synthesized.map(({ chars, requestedAt, speech }) => ({
				chars,
				route: speech.route.kind,
				startedAtMs: requestedAt - origin,
				firstByteMs: speech.arrival.firstByteAt
					? speech.arrival.firstByteAt - requestedAt
					: null,
				totalMs: speech.arrival.doneAt
					? speech.arrival.doneAt - requestedAt
					: null,
			})),
	};
}

type SpeakInput = SpeechContext & {
	/** The reply as speakable sentences; see ParlumeSentenceQueue. */
	sentences: AsyncIterable<string>;
	voiceGeneration?: number;
	confirmationSpeakerId?: string;
	signal?: AbortSignal;
};

type Playback = {
	played: boolean;
	interrupted: boolean;
	firstAudioAt?: number;
};

const auraResultSchema = z.object({
	played: z.boolean(),
	interrupted: z.boolean().default(false),
	firstAudioAt: z.number().optional(),
	failedAt: z.number().int().min(0).optional(),
	error: z.string().optional(),
	sentences: z
		.array(
			z.object({
				chars: z.number(),
				startedAtMs: z.number(),
				firstByteMs: z.number().nullable(),
				totalMs: z.number().nullable(),
				ok: z.boolean(),
			}),
		)
		.default([]),
});

// Workers AI prices @cf/deepgram/aura-2-en per input character: $0.03 per
// 1,000 characters.
const AURA_USD_PER_CHAR = 0.03 / 1_000;

function recordAuraUsage(
	context: SpeechContext,
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

function ndjsonSentences(
	sentences: AsyncGenerator<string>,
): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	return new ReadableStream<Uint8Array>({
		async pull(controller) {
			const next = await sentences.next();
			if (next.done) {
				controller.close();
				return;
			}
			controller.enqueue(
				encoder.encode(`${JSON.stringify({ text: next.value })}\n`),
			);
		},
		async cancel() {
			await sentences.return(undefined);
		},
	});
}

/**
 * Sends the sentences as text to the bridge, which synthesizes them with
 * Deepgram Aura on Workers AI and plays them: the audio never travels through
 * this worker. Returns the playback, or where the bridge stopped when Aura
 * could not speak a sentence, so another route can continue from there.
 */
async function speakThroughAura(
	input: SpeakInput,
	sentences: ReplayableSentences,
	secret: string,
	startedAt: number,
): Promise<{ done: Playback } | { resumeAt: number; firstAudioAt?: number }> {
	const requested = sentences.from(0);
	try {
		const response = await fetch(bridgeControlUrl(input.sessionId, "say"), {
			method: "POST",
			headers: {
				Authorization: `Bearer ${secret}`,
				"content-type": "application/x-ndjson",
				"x-parlume-voice-generation": String(
					input.voiceGeneration ?? 0,
				),
				...(input.confirmationSpeakerId
					? {
							"x-parlume-confirmation-speaker":
								input.confirmationSpeakerId,
						}
					: {}),
			},
			body: ndjsonSentences(requested),
			duplex: "half",
			signal: withSignal(input.signal, 90_000),
		} as RequestInit & { duplex: "half" });
		if (!response.ok) {
			throw new Error(
				`Aura speech request failed (HTTP ${response.status}).`,
			);
		}
		const result = auraResultSchema.parse(await response.json());
		for (const sentence of result.sentences) {
			if (sentence.ok) {
				recordAuraUsage(input, sentence);
				recordTurnSpeechSentence({
					chars: sentence.chars,
					route: "aura",
					startedAtMs: sentence.startedAtMs,
					firstByteMs: sentence.firstByteMs,
					totalMs: sentence.totalMs,
				});
			}
		}
		parlumeActivityLog("info", "speech.delivered", {
			sessionId: input.sessionId,
			voiceGeneration: input.voiceGeneration ?? 0,
			route: "aura",
			textChars: result.sentences.reduce(
				(sum, sentence) => sum + sentence.chars,
				0,
			),
			played: result.played,
			interrupted: result.interrupted,
			failedAt: result.failedAt ?? null,
			totalMs: Date.now() - startedAt,
			firstAudioMs: result.firstAudioAt
				? result.firstAudioAt - startedAt
				: null,
		});
		if (result.failedAt === undefined) {
			return {
				done: {
					played: result.played,
					interrupted: result.interrupted,
					firstAudioAt: result.firstAudioAt,
				},
			};
		}
		parlumeActivityLog("warn", "speech.route_failed", {
			sessionId: input.sessionId,
			route: "aura",
			failedAt: result.failedAt,
			error: result.error ?? null,
		});
		return { resumeAt: result.failedAt, firstAudioAt: result.firstAudioAt };
	} catch (error) {
		if (input.signal?.aborted) {
			throw error;
		}
		parlumeActivityLog("warn", "speech.route_failed", {
			sessionId: input.sessionId,
			route: "aura",
			failedAt: 0,
			error: errorMessage(error),
		});
		return { resumeAt: 0 };
	} finally {
		await requested.return(undefined);
	}
}

/**
 * Speaks the reply. Deepgram Aura in the bridge first; if it cannot speak a
 * sentence, the rest goes through the organization's AI Gateway or its direct
 * OpenAI key and is played from PCM sent to the bridge.
 */
export async function speakParlumeResponse(
	input: SpeakInput,
): Promise<Playback> {
	const secret = process.env.AGENT_SERVICE_SECRET;
	if (!secret) {
		throw new Error("Parlume media service secret is not configured.");
	}
	const startedAt = Date.now();
	const sentences = new ReplayableSentences(input.sentences);
	const aura = await speakThroughAura(input, sentences, secret, startedAt);
	if ("done" in aura) {
		return aura.done;
	}
	const rest = await speakThroughPcm(
		{ ...input, sentences: sentences.from(aura.resumeAt) },
		secret,
		aura.resumeAt > 0,
	);
	return {
		...rest,
		firstAudioAt: aura.firstAudioAt ?? rest.firstAudioAt,
	};
}

async function speakThroughPcm(
	input: SpeakInput,
	secret: string,
	continuing: boolean,
): Promise<Playback> {
	const startedAt = Date.now();
	let speech: SpokenReply;
	try {
		speech = await synthesizeSentences(
			input,
			input.sentences,
			input.signal,
		);
	} catch (error) {
		// Aura already spoke everything there was to say.
		if (continuing && errorMessage(error) === NOTHING_TO_SAY) {
			return { played: false, interrupted: false };
		}
		throw error;
	}
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
	for (const sentence of speech.sentenceTimings(startedAt)) {
		recordTurnSpeechSentence(sentence);
	}
	parlumeActivityLog("info", "speech.delivered", {
		sessionId: input.sessionId,
		voiceGeneration: input.voiceGeneration ?? 0,
		route: speech.route.kind,
		textChars: speech.textChars(),
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
