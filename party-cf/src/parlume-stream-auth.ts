export interface ParlumeStreamConnection {
	sessionId: string;
	token: string;
	botId: string | null;
	verified: boolean;
	verification: Promise<boolean> | null;
	generation: number;
	streamGeneration: number | null;
}

export interface ParlumeSpeakerUpdate {
	name: string;
	id: string | null;
	timestamp: number;
	isSpeaking: boolean;
}

/**
 * One chunk of the meeting's mixed audio from Attendee: 16-bit mono PCM, with
 * the bot server's wall clock at the moment the chunk was packaged.
 */
export interface ParlumeAudioMessage {
	kind: "audio";
	botId: string;
	sampleRate: number;
	timestampMs: number;
	pcm: Uint8Array<ArrayBuffer>;
}

interface ClosableStreamConnection {
	close(code: number, reason: string): void;
}

// A chunk is one browser frame (~10 ms, under 1 KB encoded); the cap leaves
// room for a provider that batches, and bounds what an unverified peer can send.
const MAX_MESSAGE_BYTES = 256 * 1024;
const MAX_SPEAKER_UPDATES = 100;
const MIXED_AUDIO_TRIGGER = "realtime_audio.mixed";

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function decodeBase64(encoded: string): Uint8Array<ArrayBuffer> | null {
	let binary: string;
	try {
		binary = atob(encoded);
	} catch {
		return null;
	}
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index++) {
		bytes[index] = binary.charCodeAt(index);
	}
	return bytes;
}

function parseSpeakerUpdate(value: unknown): ParlumeSpeakerUpdate | null {
	if (
		!isRecord(value) ||
		typeof value.name !== "string" ||
		typeof value.timestamp !== "number" ||
		!Number.isFinite(value.timestamp) ||
		typeof value.isSpeaking !== "boolean"
	) {
		return null;
	}
	return {
		name: value.name,
		id:
			typeof value.id === "string" || typeof value.id === "number"
				? String(value.id)
				: null,
		timestamp: value.timestamp,
		isSpeaking: value.isSpeaking,
	};
}

/**
 * The `speakers` control action's body. Fabric validated the webhook it came
 * from, but the bridge does not rely on that: one malformed update refuses
 * the whole request.
 */
export function parseParlumeSpeakerUpdates(
	body: unknown,
): ParlumeSpeakerUpdate[] | null {
	if (
		!isRecord(body) ||
		!Array.isArray(body.updates) ||
		body.updates.length > MAX_SPEAKER_UPDATES
	) {
		return null;
	}
	const updates = body.updates.map(parseSpeakerUpdate);
	return updates.every((update) => update !== null) ? updates : null;
}

export function parseParlumeStreamMessage(
	message: string,
): ParlumeAudioMessage | null {
	if (message.length > MAX_MESSAGE_BYTES) {
		return null;
	}
	let value: unknown;
	try {
		value = JSON.parse(message);
	} catch {
		return null;
	}
	if (
		!isRecord(value) ||
		value.trigger !== MIXED_AUDIO_TRIGGER ||
		typeof value.bot_id !== "string" ||
		value.bot_id.length === 0 ||
		!isRecord(value.data)
	) {
		return null;
	}
	const {
		chunk,
		sample_rate: sampleRate,
		timestamp_ms: timestampMs,
	} = value.data;
	if (
		typeof chunk !== "string" ||
		typeof sampleRate !== "number" ||
		!Number.isInteger(sampleRate) ||
		sampleRate <= 0 ||
		typeof timestampMs !== "number" ||
		!Number.isFinite(timestampMs)
	) {
		return null;
	}
	const pcm = decodeBase64(chunk);
	if (!pcm || pcm.length === 0 || pcm.length % 2 !== 0) {
		return null;
	}
	return { kind: "audio", botId: value.bot_id, sampleRate, timestampMs, pcm };
}

async function verifyConnection(
	host: {
		verifyStreamWithRetry(
			state: ParlumeStreamConnection,
			botId: string,
		): Promise<boolean>;
	},
	state: ParlumeStreamConnection,
	botId: string,
): Promise<boolean> {
	if (!(await host.verifyStreamWithRetry(state, botId))) {
		return false;
	}
	state.botId = botId;
	state.verified = true;
	return true;
}

/**
 * Attendee connects with no handshake, so the first audio chunk names its bot;
 * Fabric verifies that bot against the session before the stream is trusted.
 * Attendee sends a chunk every ~10 ms, so the chunks that arrive while that
 * check runs wait on it rather than start their own. Unknown message kinds from
 * a verified stream are ignored so a provider addition cannot end the meeting.
 */
export async function authenticateParlumeStreamMessage<
	TConnection extends ClosableStreamConnection,
>(
	host: {
		connections: Map<TConnection, ParlumeStreamConnection>;
		verifyStreamWithRetry(
			state: ParlumeStreamConnection,
			botId: string,
		): Promise<boolean>;
	},
	connection: TConnection,
	message: string,
): Promise<{
	message: ParlumeAudioMessage;
	state: ParlumeStreamConnection;
} | null> {
	const state = host.connections.get(connection);
	const parsed = parseParlumeStreamMessage(message);
	if (!state || (!parsed && !state.verified)) {
		connection.close(4002, "Invalid stream event");
		return null;
	}
	if (!parsed) {
		return null;
	}
	if (!state.verified) {
		state.verification ??= verifyConnection(host, state, parsed.botId);
		if (!(await state.verification)) {
			connection.close(4001, "Unauthorized");
			return null;
		}
	}
	if (state.botId !== parsed.botId) {
		connection.close(4001, "Unauthorized");
		return null;
	}
	return { message: parsed, state };
}
