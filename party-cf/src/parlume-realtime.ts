// The OpenAI Realtime protocol as Parlume speaks it: one WebSocket per
// meeting, carrying the meeting's audio in and Parlume's voice out. The
// session never answers on its own; the bridge decides when a response is
// created (see parlume-realtime-engine.ts).

import { encodeParlumeBase64 } from "./parlume-pcm";
import { decodeBase64, isRecord } from "./parlume-stream-auth";

export const PARLUME_REALTIME_SAMPLE_RATE = 24_000;
const REALTIME_URL = "https://api.openai.com/v1/realtime";
// 100 ms of 24 kHz 16-bit mono audio per append.
const APPEND_BATCH_BYTES = (PARLUME_REALTIME_SAMPLE_RATE * 2) / 10;

/**
 * The parts of the session the bridge relies on, asserted again when the
 * socket opens whatever the minted session said: OpenAI's voice activity
 * detection still reports speech starting and stopping, but never creates or
 * interrupts a response by itself.
 */
const PARLUME_REALTIME_AUDIO = {
	input: {
		format: { type: "audio/pcm", rate: PARLUME_REALTIME_SAMPLE_RATE },
		turn_detection: {
			type: "semantic_vad",
			eagerness: "auto",
			create_response: false,
			interrupt_response: false,
		},
		noise_reduction: { type: "far_field" },
		transcription: null,
	},
	output: {
		format: { type: "audio/pcm", rate: PARLUME_REALTIME_SAMPLE_RATE },
	},
} as const;

// An Azure AI Foundry resource serves the same protocol under its v1 path.
const AZURE_REALTIME_URL =
	/^https:\/\/[a-z0-9-]{2,64}\.(?:openai\.azure\.com|cognitiveservices\.azure\.com|services\.ai\.azure\.com)\/openai\/v1\/realtime$/;

export interface ParlumeRealtimeCredentials {
	clientSecret: string;
	model: string;
	/** The realtime API the secret was minted on: OpenAI's or an Azure resource's. */
	url: string;
	provider: "OPENAI_DIRECT" | "AZURE_AI_FOUNDRY";
}

/**
 * Fabric's `realtime-session` answer, or null when the meeting stays classic.
 * The secret is only ever sent to OpenAI or an Azure resource; Fabric deployed
 * before Azure hosts names no URL and means OpenAI.
 */
export function parseParlumeRealtimeCredentials(
	value: unknown,
): ParlumeRealtimeCredentials | null {
	if (
		!isRecord(value) ||
		typeof value.clientSecret !== "string" ||
		typeof value.model !== "string" ||
		!value.clientSecret ||
		!/^[a-z0-9.-]{1,64}$/.test(value.model)
	) {
		return null;
	}
	const url = value.realtimeUrl ?? REALTIME_URL;
	if (
		typeof url !== "string" ||
		(url !== REALTIME_URL && !AZURE_REALTIME_URL.test(url))
	) {
		return null;
	}
	return {
		clientSecret: value.clientSecret,
		model: value.model,
		url,
		provider: url === REALTIME_URL ? "OPENAI_DIRECT" : "AZURE_AI_FOUNDRY",
	};
}

/**
 * How the socket is opened: the client secret goes as a bearer header only.
 * OpenAI closes a session that also carries it as a WebSocket subprotocol
 * (4000 invalid_parameter, "only send one of protocol api key and
 * Authorization header").
 * @public
 */
export function parlumeRealtimeUpgrade(
	credentials: ParlumeRealtimeCredentials,
): {
	url: string;
	headers: Record<string, string>;
} {
	return {
		url: `${credentials.url}?model=${encodeURIComponent(credentials.model)}`,
		headers: {
			Upgrade: "websocket",
			Authorization: `Bearer ${credentials.clientSecret}`,
		},
	};
}

export interface ParlumeRealtimeSocket {
	send(data: string): void;
	close(code?: number, reason?: string): void;
	addEventListener(
		type: "message",
		listener: (event: { data: unknown }) => void,
	): void;
	addEventListener(
		type: "close",
		listener: (event: { code: number; reason: string }) => void,
	): void;
	addEventListener(type: "error", listener: () => void): void;
}

export async function openParlumeRealtimeSocket(
	credentials: ParlumeRealtimeCredentials,
): Promise<ParlumeRealtimeSocket> {
	const { url, headers } = parlumeRealtimeUpgrade(credentials);
	const response = await fetch(url, { headers });
	const socket = response.webSocket;
	if (!socket) {
		throw new Error(`Realtime host answered HTTP ${response.status}`);
	}
	socket.accept();
	return socket;
}

/**
 * Converts 16-bit mono PCM between sample rates by linear interpolation, one
 * chunk at a time: the last sample of each chunk carries over, so the output
 * is continuous across chunk boundaries.
 */
export class ParlumeResampler {
	readonly inputRate: number;
	private readonly outputRate: number;
	private previous: number | null = null;
	// The next output sample's position from the start of the next chunk, in
	// 1/outputRate of an input sample, so it stays exact; below zero is the
	// carried-over sample.
	private position = 0;

	constructor(inputRate: number, outputRate: number) {
		this.inputRate = inputRate;
		this.outputRate = outputRate;
	}

	push(pcm: Uint8Array): Uint8Array {
		const input = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
		const count = Math.floor(pcm.byteLength / 2);
		if (count === 0) {
			return new Uint8Array(0);
		}
		const sample = (index: number) =>
			index < 0
				? (this.previous ?? input.getInt16(0, true))
				: input.getInt16(index * 2, true);
		const last = count - 1;
		const values: number[] = [];
		for (;;) {
			const index = Math.floor(this.position / this.outputRate);
			const remainder = this.position - index * this.outputRate;
			if (index > last || (index === last && remainder > 0)) {
				break;
			}
			const a = sample(index);
			const b = remainder > 0 ? sample(index + 1) : a;
			values.push(
				Math.round(a + ((b - a) * remainder) / this.outputRate),
			);
			this.position += this.inputRate;
		}
		this.position -= count * this.outputRate;
		this.previous = sample(last);
		const output = new Uint8Array(values.length * 2);
		const view = new DataView(output.buffer);
		for (const [index, value] of values.entries()) {
			view.setInt16(index * 2, value, true);
		}
		return output;
	}
}

/** One response's token usage, split the way it is priced. */
export interface ParlumeRealtimeUsage {
	inputTextTokens: number;
	inputAudioTokens: number;
	cachedTextTokens: number;
	cachedAudioTokens: number;
	outputTextTokens: number;
	outputAudioTokens: number;
}

export interface ParlumeRealtimeFunctionCall {
	callId: string;
	name: string;
	arguments: string;
}

export type ParlumeRealtimeEvent =
	| { type: "speech_started" }
	| { type: "speech_stopped" }
	| { type: "response_created"; responseId: string }
	| {
			type: "audio_delta";
			responseId: string;
			itemId: string;
			audio: Uint8Array;
	  }
	| {
			type: "response_done";
			responseId: string;
			status: string;
			usage: ParlumeRealtimeUsage | null;
			functionCalls: ParlumeRealtimeFunctionCall[];
			/** What Parlume said, for the summary a new session starts from. */
			transcripts: string[];
	  }
	| {
			type: "error";
			code: string | null;
			param: string | null;
			message: string | null;
	  };

function count(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0
		? value
		: 0;
}

function parseUsage(value: unknown): ParlumeRealtimeUsage | null {
	if (!isRecord(value)) {
		return null;
	}
	const input: Record<string, unknown> = isRecord(value.input_token_details)
		? value.input_token_details
		: {};
	const cached: Record<string, unknown> = isRecord(
		input.cached_tokens_details,
	)
		? input.cached_tokens_details
		: {};
	const output: Record<string, unknown> = isRecord(value.output_token_details)
		? value.output_token_details
		: {};
	const cachedTextTokens = count(cached.text_tokens);
	const cachedAudioTokens = count(cached.audio_tokens);
	return {
		inputTextTokens: Math.max(
			0,
			count(input.text_tokens) - cachedTextTokens,
		),
		inputAudioTokens: Math.max(
			0,
			count(input.audio_tokens) - cachedAudioTokens,
		),
		cachedTextTokens,
		cachedAudioTokens,
		outputTextTokens: count(output.text_tokens),
		outputAudioTokens: count(output.audio_tokens),
	};
}

function parseOutput(value: unknown): {
	functionCalls: ParlumeRealtimeFunctionCall[];
	transcripts: string[];
} {
	const functionCalls: ParlumeRealtimeFunctionCall[] = [];
	const transcripts: string[] = [];
	for (const item of Array.isArray(value) ? value : []) {
		if (!isRecord(item)) {
			continue;
		}
		if (
			item.type === "function_call" &&
			typeof item.call_id === "string" &&
			typeof item.name === "string" &&
			typeof item.arguments === "string"
		) {
			functionCalls.push({
				callId: item.call_id,
				name: item.name,
				arguments: item.arguments,
			});
		}
		if (item.type === "message" && Array.isArray(item.content)) {
			for (const part of item.content) {
				if (
					isRecord(part) &&
					typeof part.transcript === "string" &&
					part.transcript.trim()
				) {
					transcripts.push(part.transcript.trim());
				}
			}
		}
	}
	return { functionCalls, transcripts };
}

/**
 * The server events the engine acts on; everything else is ignored.
 * @public
 */
export function parseParlumeRealtimeEvent(
	data: unknown,
): ParlumeRealtimeEvent | null {
	if (typeof data !== "string") {
		return null;
	}
	let event: unknown;
	try {
		event = JSON.parse(data);
	} catch {
		return null;
	}
	if (!isRecord(event)) {
		return null;
	}
	switch (event.type) {
		case "input_audio_buffer.speech_started":
			return { type: "speech_started" };
		case "input_audio_buffer.speech_stopped":
			return { type: "speech_stopped" };
		case "response.created":
			return isRecord(event.response) &&
				typeof event.response.id === "string"
				? { type: "response_created", responseId: event.response.id }
				: null;
		case "response.output_audio.delta": {
			const audio =
				typeof event.delta === "string"
					? decodeBase64(event.delta)
					: null;
			return audio &&
				typeof event.response_id === "string" &&
				typeof event.item_id === "string"
				? {
						type: "audio_delta",
						responseId: event.response_id,
						itemId: event.item_id,
						audio,
					}
				: null;
		}
		case "response.done": {
			const response = event.response;
			if (!isRecord(response) || typeof response.id !== "string") {
				return null;
			}
			return {
				type: "response_done",
				responseId: response.id,
				status:
					typeof response.status === "string"
						? response.status
						: "unknown",
				usage: parseUsage(response.usage),
				...parseOutput(response.output),
			};
		}
		case "error": {
			const error = isRecord(event.error) ? event.error : {};
			const text = (value: unknown, max: number) =>
				typeof value === "string" ? value.slice(0, max) : null;
			return {
				type: "error",
				code: text(error.code, 100),
				param: text(error.param, 200),
				message: text(error.message, 300),
			};
		}
		default:
			return null;
	}
}

/**
 * The client side of one Realtime socket: what Parlume sends, as typed calls.
 * Meeting audio is resampled to the session's rate and sent in 100 ms appends.
 */
export class ParlumeRealtimeClient {
	private resampler: ParlumeResampler | null = null;
	private pending: Uint8Array[] = [];
	private pendingBytes = 0;
	private open = true;

	constructor(
		private readonly socket: ParlumeRealtimeSocket,
		handlers: {
			onEvent: (event: ParlumeRealtimeEvent) => void;
			onClose: (detail: string) => void;
		},
	) {
		socket.addEventListener("message", (event) => {
			const parsed = parseParlumeRealtimeEvent(event.data);
			if (parsed) {
				handlers.onEvent(parsed);
			}
		});
		socket.addEventListener("close", (event) => {
			this.open = false;
			handlers.onClose(`${event.code} ${event.reason}`.trim());
		});
		socket.addEventListener("error", () => {
			this.open = false;
			handlers.onClose("error");
		});
	}

	get isOpen(): boolean {
		return this.open;
	}

	configure(): void {
		this.send({
			type: "session.update",
			session: { type: "realtime", audio: PARLUME_REALTIME_AUDIO },
		});
	}

	appendAudio(pcm: Uint8Array, sampleRate: number): void {
		if (this.resampler?.inputRate !== sampleRate) {
			this.resampler = new ParlumeResampler(
				sampleRate,
				PARLUME_REALTIME_SAMPLE_RATE,
			);
		}
		const resampled = this.resampler.push(pcm);
		if (resampled.byteLength === 0) {
			return;
		}
		this.pending.push(resampled);
		this.pendingBytes += resampled.byteLength;
		if (this.pendingBytes >= APPEND_BATCH_BYTES) {
			this.flushAudio();
		}
	}

	/** Sends whatever meeting audio is still batched. */
	flushAudio(): void {
		if (this.pendingBytes === 0) {
			return;
		}
		const batch = new Uint8Array(this.pendingBytes);
		let offset = 0;
		for (const chunk of this.pending) {
			batch.set(chunk, offset);
			offset += chunk.byteLength;
		}
		this.pending = [];
		this.pendingBytes = 0;
		this.send({
			type: "input_audio_buffer.append",
			audio: encodeParlumeBase64(batch),
		});
	}

	/** Ends the current user turn now, before voice activity detection does. */
	commitAudio(): void {
		this.flushAudio();
		this.send({ type: "input_audio_buffer.commit" });
	}

	addMessage(role: "system" | "user", text: string): void {
		this.send({
			type: "conversation.item.create",
			item: {
				type: "message",
				role,
				content: [{ type: "input_text", text }],
			},
		});
	}

	addFunctionOutput(callId: string, output: object): void {
		this.send({
			type: "conversation.item.create",
			item: {
				type: "function_call_output",
				call_id: callId,
				output: JSON.stringify(output),
			},
		});
	}

	createResponse(kind: string): void {
		this.send({
			type: "response.create",
			response: { metadata: { kind } },
		});
	}

	cancelResponse(responseId: string | null): void {
		this.send(
			responseId
				? { type: "response.cancel", response_id: responseId }
				: { type: "response.cancel" },
		);
	}

	/** Cuts an assistant item's audio to what the meeting actually heard. */
	truncate(itemId: string, audioEndMs: number): void {
		this.send({
			type: "conversation.item.truncate",
			item_id: itemId,
			content_index: 0,
			audio_end_ms: audioEndMs,
		});
	}

	close(reason: string): void {
		this.open = false;
		try {
			this.socket.close(1000, reason);
		} catch {
			// Already closed.
		}
	}

	private send(event: object): void {
		if (this.open) {
			this.socket.send(JSON.stringify(event));
		}
	}
}
