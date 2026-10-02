export interface ParlumeStreamConnection {
	sessionId: string;
	token: string;
	botId: string | null;
	verified: boolean;
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
 * Text messages of the provider's audio stream. Binary messages carry the
 * mixed meeting audio and are handled separately.
 */
export type ParlumeStreamMessage =
	| {
			kind: "handshake";
			botId: string;
			sampleRate: number;
			startTime: number | null;
	  }
	| { kind: "speakers"; updates: ParlumeSpeakerUpdate[] };

interface ClosableStreamConnection {
	close(code: number, reason: string): void;
}

const MAX_MESSAGE_BYTES = 64 * 1024;

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function parseSpeakerUpdate(value: unknown): ParlumeSpeakerUpdate | null {
	if (
		!isRecord(value) ||
		typeof value.name !== "string" ||
		typeof value.timestamp !== "number" ||
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

export function parseParlumeStreamMessage(
	message: string,
): ParlumeStreamMessage | null {
	if (message.length > MAX_MESSAGE_BYTES) {
		return null;
	}
	let value: unknown;
	try {
		value = JSON.parse(message);
	} catch {
		return null;
	}
	if (Array.isArray(value)) {
		return {
			kind: "speakers",
			updates: value
				.map(parseSpeakerUpdate)
				.filter((update) => update !== null),
		};
	}
	if (
		!isRecord(value) ||
		typeof value.bot_id !== "string" ||
		value.bot_id.length === 0 ||
		typeof value.sample_rate !== "number" ||
		!Number.isInteger(value.sample_rate) ||
		value.sample_rate <= 0
	) {
		return null;
	}
	return {
		kind: "handshake",
		botId: value.bot_id,
		sampleRate: value.sample_rate,
		startTime:
			typeof value.start_time === "number" ? value.start_time : null,
	};
}

/**
 * The provider's handshake names its bot; Fabric verifies that bot against
 * the session before the stream is trusted. Unknown message kinds from a
 * verified stream are ignored so a provider addition cannot end the meeting.
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
	message: ParlumeStreamMessage;
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
	if (parsed.kind === "speakers") {
		if (!state.verified) {
			connection.close(4001, "Unauthorized");
			return null;
		}
		return { message: parsed, state };
	}
	if (!state.verified) {
		if (!(await host.verifyStreamWithRetry(state, parsed.botId))) {
			connection.close(4001, "Unauthorized");
			return null;
		}
		state.botId = parsed.botId;
		state.verified = true;
	}
	if (state.botId !== parsed.botId) {
		connection.close(4001, "Unauthorized");
		return null;
	}
	return { message: parsed, state };
}
