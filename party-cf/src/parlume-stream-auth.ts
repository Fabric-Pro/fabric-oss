export interface ParlumeStreamConnection {
	sessionId: string;
	token: string;
	botId: string | null;
	verified: boolean;
	generation: number;
	streamGeneration: number | null;
}

interface SessionStartedEvent {
	event: "session.started";
	bot_id: string;
}

interface TranscriptSegmentEvent {
	event: "transcript.segment";
	bot_id: string;
	data: {
		text: string;
		isFinal: boolean;
		utteranceStart?: number;
		utteranceEnd?: number;
		speaker?: { name?: string; id?: string } | null;
	};
}

interface IncompleteTranscriptSegmentEvent {
	event: "transcript.incomplete";
	bot_id: string;
}

interface StreamErrorEvent {
	event: "error";
	bot_id: string;
}

export type ParlumeStreamEvent =
	| SessionStartedEvent
	| TranscriptSegmentEvent
	| IncompleteTranscriptSegmentEvent
	| StreamErrorEvent;

interface ClosableStreamConnection {
	close(code: number, reason: string): void;
}

const MAX_EVENT_BYTES = 64 * 1024;

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function parseEvent(message: string): ParlumeStreamEvent | null {
	if (message.length > MAX_EVENT_BYTES) {
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
		typeof value.event !== "string" ||
		typeof value.bot_id !== "string" ||
		value.bot_id.length === 0
	) {
		return null;
	}
	if (value.event === "session.started") {
		return { event: "session.started", bot_id: value.bot_id };
	}
	if (value.event === "error") {
		return { event: "error", bot_id: value.bot_id };
	}
	if (value.event !== "transcript.segment") {
		return null;
	}
	if (!isRecord(value.data)) {
		return { event: "transcript.incomplete", bot_id: value.bot_id };
	}
	const { text, isFinal, utteranceStart, utteranceEnd, speaker } = value.data;
	if (typeof text !== "string" || typeof isFinal !== "boolean") {
		return { event: "transcript.incomplete", bot_id: value.bot_id };
	}
	const parsedSpeaker = isRecord(speaker)
		? {
				name:
					typeof speaker.name === "string" ? speaker.name : undefined,
				id:
					typeof speaker.id === "string" ||
					typeof speaker.id === "number"
						? String(speaker.id)
						: undefined,
			}
		: null;
	return {
		event: "transcript.segment",
		bot_id: value.bot_id,
		data: {
			text,
			isFinal,
			utteranceStart:
				typeof utteranceStart === "number" ? utteranceStart : undefined,
			utteranceEnd:
				typeof utteranceEnd === "number" ? utteranceEnd : undefined,
			speaker: parsedSpeaker,
		},
	};
}

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
	event: ParlumeStreamEvent;
	state: ParlumeStreamConnection;
} | null> {
	const state = host.connections.get(connection);
	const event = parseEvent(message);
	if (!state || !event) {
		connection.close(4002, "Invalid stream event");
		return null;
	}
	if (!state.verified) {
		if (!(await host.verifyStreamWithRetry(state, event.bot_id))) {
			connection.close(4001, "Unauthorized");
			return null;
		}
		state.botId = event.bot_id;
		state.verified = true;
	}
	if (state.botId !== event.bot_id) {
		connection.close(4001, "Unauthorized");
		return null;
	}
	return { event, state };
}
