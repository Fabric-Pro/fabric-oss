import { randomUUID } from "node:crypto";
import {
	AUDIO_PROVIDER_REQUIRED,
	getAISpeechModel,
	resolveOpenAiApiKey,
} from "@repo/ai";
import { logAiUsageAsync } from "@repo/database";
import { generateSpeech } from "ai";
import { z } from "zod";
import { PARLUME_PCM_SAMPLE_RATE, pcmFromWav } from "./parlume-audio";
import { recordParlumeAuraUsage } from "./parlume-aura-usage";
import { parlumeActivityLog } from "./parlume-log";
import { AvailableSentences, ReplayableSentences } from "./parlume-spoken-text";
import {
	recordTurnSpeechSentence,
	type SpeechSentenceTiming,
} from "./shared/turn-timing";

/**
 * The longest Parlume speaks in one answer: 45 seconds, at about 15
 * characters a second. The bridge holds reads aloud and the realtime voice to
 * the same budget (`PARLUME_SPOKEN_BUDGET_SECONDS` in party-cf).
 */
const PARLUME_SPOKEN_BUDGET_SECONDS = 45;
const PARLUME_SPOKEN_CHARS_PER_SECOND = 15;
/** The most a reply speaks when the meeting chat cannot take the rest. */
export const PARLUME_MAX_SPOKEN_CHARS =
	PARLUME_SPOKEN_BUDGET_SECONDS * PARLUME_SPOKEN_CHARS_PER_SECOND;
/** The spoken headline of a reply whose detail goes to the meeting chat. */
export const PARLUME_HEADLINE_SPOKEN_CHARS = 350;
const NOTHING_TO_SAY = "Parlume had nothing to say.";
const MAX_PCM_BYTES = 6 * 1024 * 1024;
// The bridge refuses a longer chat message, and splits a long one into posts
// itself; see `MAX_OUTBOUND_CHARS` in the bridge's chat channel.
const MAX_CHAT_CHARS = 8_000;
const CHAT_CUT_MARKER =
	"\n\n[Cut here: the rest was too long for the meeting chat.]";
// The bridge keeps this much of a realtime job's result for the voice.
const MAX_RESULT_CHARS = 4_000;
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
	action:
		| "speak"
		| "say"
		| "stop"
		| "verify-generation"
		| "chat"
		| "fabric-result",
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

/**
 * What the bridge knows about a turn's voice generation. `current`: the turn
 * is still the one being answered. `chatAvailable`: Parlume's posts can still
 * be expected to reach the meeting chat.
 */
export type ParlumeVoiceState = {
	current: boolean;
	chatAvailable: boolean;
};

const UNREACHABLE_VOICE_STATE: ParlumeVoiceState = {
	current: false,
	chatAvailable: true,
};

const voiceStateResponse = z.object({
	current: z.boolean(),
	chatAvailable: z.boolean().default(true),
	// Whether a bot socket plays speech now; a bridge that does not say plays.
	live: z.boolean().default(true),
	/** How many sentences of the reply named in the request were heard. */
	heard: z.number().int().min(0).default(0),
});

/** The bridge's `verify-generation`; null when it does not answer. */
async function verifyParlumeGeneration(input: {
	sessionId: string;
	voiceGeneration: number;
	/** The reply whose heard sentences the bridge reports. */
	replyId?: string;
	signal?: AbortSignal;
}): Promise<z.infer<typeof voiceStateResponse> | null> {
	const secret = process.env.AGENT_SERVICE_SECRET;
	if (!secret || input.signal?.aborted) {
		return null;
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
					...(input.replyId ? { replyId: input.replyId } : {}),
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
			return null;
		}
		return voiceStateResponse.parse(await response.json());
	} catch {
		return null;
	}
}

export async function readParlumeVoiceState(input: {
	sessionId: string;
	voiceGeneration: number;
	signal?: AbortSignal;
}): Promise<ParlumeVoiceState> {
	const state = await verifyParlumeGeneration(input);
	return state
		? { current: state.current, chatAvailable: state.chatAvailable }
		: UNREACHABLE_VOICE_STATE;
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
	signal?: AbortSignal;
};

type Playback = {
	played: boolean;
	interrupted: boolean;
	/** How many sentences, from the first, were heard to their end. */
	heard?: number;
	/**
	 * The bridge lost the reply, as when it restarted, and the bot was not
	 * back in time to hear the rest: none of it after `heard` was said.
	 */
	lost?: boolean;
	firstAudioAt?: number;
};

const auraResultSchema = z.object({
	played: z.boolean(),
	interrupted: z.boolean().default(false),
	heard: z.number().int().min(0).optional(),
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

const auraPartResponse = z.object({
	accepted: z.boolean(),
	/** How many of the reply's sentences, from the first, were heard so far. */
	heard: z.number().int().min(0).optional(),
});

type AuraPart = {
	reply: string;
	index: number;
	sentences?: string[];
	last?: boolean;
	cancel?: boolean;
};

/** One numbered part of a reply sent to the bridge's `say` endpoint. */
function sendAuraPart(
	input: SpeakInput,
	secret: string,
	part: AuraPart,
	signal: AbortSignal,
): Promise<Response> {
	return fetch(bridgeControlUrl(input.sessionId, "say"), {
		method: "POST",
		headers: {
			Authorization: `Bearer ${secret}`,
			"content-type": "application/x-ndjson",
			"x-parlume-voice-generation": String(input.voiceGeneration ?? 0),
			"x-parlume-reply": part.reply,
			"x-parlume-reply-part": String(part.index),
			...(part.last ? { "x-parlume-reply-last": "1" } : {}),
			...(part.cancel ? { "x-parlume-reply-cancel": "1" } : {}),
		},
		body: (part.sentences ?? [])
			.map((text) => `${JSON.stringify({ text })}\n`)
			.join(""),
		signal,
	});
}

type AuraOutcome =
	| { done: Playback }
	| {
			resumeAt: number;
			firstAudioAt?: number;
			played?: boolean;
			/** The reply whose opening part got no answer from the bridge. */
			lostReply?: string;
	  };

/**
 * Withdraws a reply whose first part got no answer, so the bridge stops
 * playing it; resolves to how many of its sentences the bridge says were
 * heard, or 0 when it gives no answer either.
 */
async function withdrawAuraReply(
	input: SpeakInput,
	secret: string,
	reply: string,
	index: number,
): Promise<number> {
	try {
		const response = await sendAuraPart(
			input,
			secret,
			{ reply, index, cancel: true },
			AbortSignal.timeout(5_000),
		);
		const answer = auraPartResponse.safeParse(await response.json());
		return answer.data?.heard ?? 0;
	} catch {
		return 0;
	}
}

/**
 * Sends the sentences as text to the bridge, which synthesizes them with
 * Deepgram Aura on Workers AI and plays them: the audio never travels through
 * this worker. Returns the playback, or where the bridge stopped when Aura
 * could not speak a sentence, so another route can continue from there.
 *
 * The reply goes as numbered parts, each sent the moment its sentences exist:
 * the edge in front of the bridge holds a streamed request body until it
 * ends, so a reply sent as one streamed body was heard only once the agent
 * had finished. The first part's answer is the playback of the whole reply.
 * When that answer is lost, such as when the bridge restarts, the rest is
 * spoken another way from the first sentence the bridge did not report
 * heard, not from the start.
 */
async function speakThroughAura(
	input: SpeakInput,
	sentences: ReplayableSentences,
	secret: string,
	startedAt: number,
): Promise<AuraOutcome> {
	const reply = randomUUID();
	const parts = new AvailableSentences(sentences.from(0));
	let nextPart = 1;
	// The bridge has answered for the reply: no more parts are sent.
	let settled = false;
	// A sentence did not reach the bridge while it was still listening.
	let undelivered = false;
	// The most sentences the bridge has reported heard, in a part's answer.
	let heard = 0;
	const sendRest = async () => {
		for (;;) {
			const part = await parts.next();
			if (settled) {
				undelivered ||= part.sentences.length > 0;
				return;
			}
			const response = await sendAuraPart(
				input,
				secret,
				{ reply, index: nextPart++, ...part },
				withSignal(input.signal, 15_000),
			);
			const answer = response.ok
				? auraPartResponse.safeParse(await response.json()).data
				: undefined;
			heard = Math.max(heard, answer?.heard ?? 0);
			if (answer?.accepted !== true) {
				undelivered ||= part.sentences.length > 0;
				return;
			}
			if (part.last) {
				return;
			}
		}
	};
	let opened = false;
	// The bridge answered the opening part: a 5xx is the edge's answer for
	// a bridge that went away mid-reply, as a restart does.
	let answered = false;
	try {
		const first = await parts.next();
		opened = true;
		const opening = sendAuraPart(
			input,
			secret,
			{ reply, index: 0, ...first },
			withSignal(input.signal, 90_000),
		);
		const rest = first.last
			? Promise.resolve()
			: sendRest().catch((error: unknown) => {
					undelivered = true;
					if (!input.signal?.aborted) {
						parlumeActivityLog("warn", "speech.part_failed", {
							sessionId: input.sessionId,
							route: "aura",
							error: errorMessage(error),
						});
					}
				});
		const response = await opening;
		settled = true;
		answered = response.status < 500;
		if (!response.ok) {
			throw new Error(
				`Aura speech request failed (HTTP ${response.status}).`,
			);
		}
		const result = auraResultSchema.parse(await response.json());
		for (const sentence of result.sentences) {
			if (sentence.ok) {
				recordParlumeAuraUsage(input, sentence);
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
			heard: result.heard ?? null,
			failedAt: result.failedAt ?? null,
			totalMs: Date.now() - startedAt,
			firstAudioMs: result.firstAudioAt
				? result.firstAudioAt - startedAt
				: null,
		});
		if (result.failedAt !== undefined) {
			parlumeActivityLog("warn", "speech.route_failed", {
				sessionId: input.sessionId,
				route: "aura",
				failedAt: result.failedAt,
				error: result.error ?? null,
			});
			return {
				resumeAt: result.failedAt,
				firstAudioAt: result.firstAudioAt,
			};
		}
		// Played to its end, yet a sentence never reached the bridge (it
		// stopped waiting for the next part): the rest goes another way.
		if (result.played) {
			await rest;
			if (undelivered) {
				parlumeActivityLog("warn", "speech.route_failed", {
					sessionId: input.sessionId,
					route: "aura",
					failedAt: result.sentences.length,
					error: "A sentence did not reach the bridge",
				});
				return {
					resumeAt: result.sentences.length,
					firstAudioAt: result.firstAudioAt,
					played: true,
				};
			}
		}
		return {
			done: {
				played: result.played,
				interrupted: result.interrupted,
				heard: result.heard,
				firstAudioAt: result.firstAudioAt,
			},
		};
	} catch (error) {
		if (input.signal?.aborted) {
			// The bridge drops what it queued of a reply the turn gave up on.
			if (opened) {
				sendAuraPart(
					input,
					secret,
					{ reply, index: nextPart, cancel: true },
					AbortSignal.timeout(5_000),
				).catch(() => {});
			}
			throw error;
		}
		settled = true;
		const withdrawnHeard = opened
			? await withdrawAuraReply(input, secret, reply, nextPart)
			: 0;
		// Read after the withdrawal: a part's answer may land meanwhile.
		const resumeAt = opened ? Math.max(heard, withdrawnHeard) : 0;
		parlumeActivityLog("warn", "speech.route_failed", {
			sessionId: input.sessionId,
			route: "aura",
			failedAt: resumeAt,
			error: errorMessage(error),
		});
		return opened && !answered
			? { resumeAt, lostReply: reply }
			: { resumeAt };
	} finally {
		settled = true;
	}
}

// A reply the bridge lost waits this long for the bot to be back, asking
// this often.
const RESUME_WINDOW_MS = 15_000;
const RESUME_POLL_MS = 1_000;

/**
 * Where a reply the bridge lost goes on: `resend` from `resumeAt`; `missed`
 * when no bot socket came back in time; `withdrawn` when its turn is no
 * longer the one being answered.
 */
type BridgeResume = {
	outcome: "resend" | "missed" | "withdrawn";
	resumeAt: number;
};

/** What the bridge's answer decides, or null while the bot may come back. */
function bridgeResumeOutcome(
	state: z.infer<typeof voiceStateResponse>,
	waitedMs: number,
): BridgeResume["outcome"] | null {
	if (!state.current) {
		return "withdrawn";
	}
	if (state.live) {
		return "resend";
	}
	return waitedMs >= RESUME_WINDOW_MS ? "missed" : null;
}

/**
 * The bridge lost the answer to a reply's opening part, as when it restarts
 * mid-reply. Its stored record says how many sentences were heard, and the
 * rest is sent again once a bot socket is back, within `RESUME_WINDOW_MS`.
 * A bridge that does not answer is taken to play, as before.
 */
async function awaitParlumeBridge(
	input: SpeakInput,
	reply: string,
	heard: number,
): Promise<BridgeResume> {
	const lostAt = Date.now();
	let resumeAt = heard;
	for (;;) {
		const state = await verifyParlumeGeneration({
			sessionId: input.sessionId,
			voiceGeneration: input.voiceGeneration ?? 0,
			replyId: reply,
			signal: input.signal,
		});
		if (!state) {
			return { outcome: "resend", resumeAt };
		}
		resumeAt = Math.max(resumeAt, state.heard);
		const waitedMs = Date.now() - lostAt;
		const outcome = bridgeResumeOutcome(state, waitedMs);
		if (outcome !== null) {
			const resumed = outcome === "resend";
			parlumeActivityLog(
				resumed ? "info" : "warn",
				resumed ? "speech.resumed" : "speech.resume_missed",
				{
					sessionId: input.sessionId,
					voiceGeneration: input.voiceGeneration ?? 0,
					cause: "bridge_lost",
					outcome,
					heard: resumeAt,
					gapMs: waitedMs,
				},
			);
			return { outcome, resumeAt };
		}
		await new Promise((resolve) => setTimeout(resolve, RESUME_POLL_MS));
	}
}

/**
 * Speaks the reply. Deepgram Aura in the bridge first; if it cannot speak a
 * sentence, the rest goes through the organization's AI Gateway or its direct
 * OpenAI key and is played from PCM sent to the bridge. A reply the bridge
 * lost, as when it restarted, goes on at the first sentence it did not hear
 * (`awaitParlumeBridge`).
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
	const resume: BridgeResume =
		aura.lostReply === undefined
			? { outcome: "resend", resumeAt: aura.resumeAt }
			: await awaitParlumeBridge(input, aura.lostReply, aura.resumeAt);
	if (resume.outcome !== "resend") {
		return {
			played: aura.played === true,
			interrupted: true,
			heard: resume.resumeAt,
			lost: resume.outcome === "missed",
			firstAudioAt: aura.firstAudioAt,
		};
	}
	const rest = await speakThroughPcm(
		{ ...input, sentences: sentences.from(resume.resumeAt) },
		secret,
		resume.resumeAt > 0,
	);
	return {
		...rest,
		played: rest.played || aura.played === true,
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

export type ParlumeChatSendResult =
	| { sent: true; tag: string }
	| { sent: false; reason: "chat_unavailable" | "guests_present" | "failed" };

/**
 * A turn's post opens with what it is and whom it answers: "**Answer** for
 * Alex", then the request quoted. The bridge writes both lines from these
 * fields, never the model, and keeps them whole when it shortens the post.
 */
export interface ParlumeChatPostHeader {
	kind: "answer" | "detail" | "error";
	asker: string | null;
	request: string;
}

/** The bridge quotes at most 120 characters of the request. */
const MAX_HEADER_REQUEST_CHARS = 500;

const chatSendResponse = z.object({
	sent: z.boolean(),
	tag: z.string().optional(),
	reason: z.string().optional(),
});

/**
 * Sends a message to the meeting chat. Goes through the bridge, which holds
 * the session's provider bot id, tags the post ("[P7] …") and later confirms
 * it appeared; the meeting provider's key stays in the web app. `sent` means
 * the provider queued it, not that anyone has seen it. A chat the bridge has
 * found out of reach answers `chat_unavailable` at once, and one in front
 * of someone Fabric has not confirmed `guests_present`; the bridge keeps a
 * recap refused so and posts it once the chat opens. `final` marks the
 * last post of a reply typed in the chat, which ends that request.
 */
export async function postParlumeMeetingChat(input: {
	sessionId: string;
	message: string;
	turnId?: string;
	voiceGeneration?: number;
	final?: boolean;
	/** The recap: one paragraph, without an answer's formatting. */
	plain?: boolean;
	/** What the post is for its turn and who asked: the bridge's first lines. */
	header?: ParlumeChatPostHeader;
}): Promise<ParlumeChatSendResult> {
	return sendBridgeChat(input.sessionId, {
		message: fitChatMessage(input.message),
		turnId: input.turnId,
		voiceGeneration: input.voiceGeneration,
		final: input.final,
		plain: input.plain,
		header: input.header && {
			...input.header,
			request: input.header.request.slice(0, MAX_HEADER_REQUEST_CHARS),
		},
	});
}

/** A message the bridge accepts whole, or cut with a visible marker, never silently. */
function fitChatMessage(message: string): string {
	if (message.length <= MAX_CHAT_CHARS) {
		return message;
	}
	const kept = message
		.slice(0, MAX_CHAT_CHARS - CHAT_CUT_MARKER.length)
		.trimEnd();
	return `${kept}${CHAT_CUT_MARKER}`;
}

/**
 * Posts a change Parlume proposed, with its Confirm and Dismiss links. The
 * bridge tags the post and keeps the action, both links and the spoken form,
 * so `go` on the post can point to the Confirm link and `say` can read it.
 */
export async function postParlumeProposal(input: {
	sessionId: string;
	turnId: string;
	/** The bridge refuses a post for an answer someone stopped. */
	voiceGeneration: number;
	actionId: string;
	message: string;
	spoken: string;
	confirmUrl: string;
	dismissUrl: string;
}): Promise<ParlumeChatSendResult> {
	return sendBridgeChat(input.sessionId, {
		turnId: input.turnId,
		voiceGeneration: input.voiceGeneration,
		message: input.message.slice(0, MAX_CHAT_CHARS),
		proposal: {
			actionId: input.actionId,
			spoken: input.spoken,
			confirmUrl: input.confirmUrl,
			dismissUrl: input.dismissUrl,
		},
	});
}

const chatCloseResponse = z.object({ closed: z.literal(true) });

/**
 * Tells the bridge that a request typed in the chat is answered by a post
 * the turn already made, its proposal, so the turn posts nothing more. False
 * when the bridge did not take it.
 */
export async function closeParlumeMeetingChat(input: {
	sessionId: string;
	turnId: string;
	voiceGeneration: number;
}): Promise<boolean> {
	const result = await postBridgeChat(input.sessionId, {
		message: "",
		turnId: input.turnId,
		voiceGeneration: input.voiceGeneration,
		final: true,
		close: true,
	});
	return chatCloseResponse.safeParse(result).success;
}

/** The bridge's answer to a chat request, or null when it gave none. */
async function postBridgeChat(
	sessionId: string,
	body: Record<string, unknown>,
): Promise<unknown> {
	const secret = process.env.AGENT_SERVICE_SECRET;
	if (!secret) {
		return null;
	}
	try {
		const response = await fetch(bridgeControlUrl(sessionId, "chat"), {
			method: "POST",
			headers: {
				Authorization: `Bearer ${secret}`,
				"content-type": "application/json",
			},
			body: JSON.stringify(body),
			// The bridge holds a post for up to 30 s while Parlume speaks.
			signal: AbortSignal.timeout(45_000),
		});
		return response.ok ? await response.json() : null;
	} catch {
		return null;
	}
}

async function sendBridgeChat(
	sessionId: string,
	body: Record<string, unknown>,
): Promise<ParlumeChatSendResult> {
	const failed = { sent: false, reason: "failed" } as const;
	const parsed = chatSendResponse.safeParse(
		await postBridgeChat(sessionId, body),
	);
	if (!parsed.success) {
		return failed;
	}
	const result = parsed.data;
	if (result.sent && result.tag) {
		return { sent: true, tag: result.tag };
	}
	// Until Fabric has confirmed everyone there, Parlume answers nothing in
	// the meeting chat.
	return result.reason === "chat_unavailable" ||
		result.reason === "guests_present"
		? { sent: false, reason: result.reason }
		: failed;
}

const realtimeResultResponse = z.object({ accepted: z.boolean() });

/**
 * Hands a realtime voice job's outcome to the bridge, which speaks it once
 * the voice is free. False when the bridge did not take it: the job was
 * cancelled, or the meeting's voice is no longer realtime.
 */
export async function postParlumeRealtimeResult(input: {
	sessionId: string;
	/** The turn that answered the job; the bridge reports when it was heard. */
	turnId?: string;
	job: string;
	status: "completed" | "failed";
	text: string;
	chatTags: string[];
}): Promise<boolean> {
	const secret = process.env.AGENT_SERVICE_SECRET;
	if (!secret) {
		return false;
	}
	try {
		const response = await fetch(
			bridgeControlUrl(input.sessionId, "fabric-result"),
			{
				method: "POST",
				headers: {
					Authorization: `Bearer ${secret}`,
					"content-type": "application/json",
				},
				body: JSON.stringify({
					job: input.job,
					status: input.status,
					text: input.text.slice(0, MAX_RESULT_CHARS),
					chatTags: input.chatTags,
					turnId: input.turnId,
				}),
				signal: AbortSignal.timeout(15_000),
			},
		);
		if (!response.ok) {
			return false;
		}
		return (
			realtimeResultResponse.safeParse(await response.json()).data
				?.accepted === true
		);
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
