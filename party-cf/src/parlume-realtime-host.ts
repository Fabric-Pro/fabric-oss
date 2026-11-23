import type { ParlumeAuraOutlet } from "./parlume-aura";
import type { ParlumeFabricResult } from "./parlume-fabric-result";
import type {
	ParlumeRealtimeCredentials,
	ParlumeRealtimeSocket,
	ParlumeRealtimeUsage,
} from "./parlume-realtime";

// What the realtime engine needs from the meeting's bridge, and the context
// the bridge keeps for it across a Durable Object restart.

type ParlumeRealtimeChatResult =
	/** `shown`: the meeting chat showed the post before the voice was told. */
	| { posted: true; tag: string; shown: boolean }
	| { posted: false; reason: string };

/** Who asked for a response: their name, and their speaker key. */
export interface ParlumeRealtimeRequester {
	name: string | null;
	key: string | null;
}

/** Why the voice gives a response: what asked for it. */
export type ParlumeRealtimeResponseKind =
	| "wake"
	| "chat"
	| "tool"
	| "result"
	| "resume";

/**
 * A spoken response its session ended before it did: what it said so far,
 * how much of that the meeting heard, and whose answer it was. A resume
 * response on the next session goes on after the heard part.
 */
export interface ParlumeRealtimeCut {
	kind: ParlumeRealtimeResponseKind;
	/** What ended its session: a drop, a forced rotation, or a restart. */
	cause: "dropped" | "rotation" | "restart";
	/** The output transcript as it streamed. */
	transcript: string;
	/** How many characters of it, from the start, were heard. */
	heardChars: number;
	/** Speech it had sent that was never played. */
	lostMs: number;
	turnId: string | null;
	result: ParlumeFabricResult | null;
	requester: ParlumeRealtimeRequester | null;
	/** When it was cut. */
	at: number;
}

export interface ParlumeRealtimeContext {
	lines: string[];
	/** `requester` is absent from contexts saved before it was kept. */
	jobs: Array<{
		job: string;
		generation: number;
		requester?: ParlumeRealtimeRequester | null;
	}>;
	jobCounter: number;
	/** Web addresses Fabric results gave; absent from contexts saved before. */
	addresses?: string[];
	/**
	 * The spoken response in progress, as a restart would cut it, or one cut
	 * short whose resume has not started yet.
	 */
	cut?: ParlumeRealtimeCut;
}

export interface ParlumeRealtimeEngineHost {
	/** A client secret for a new session, or null when there is none to have. */
	credentials(): Promise<ParlumeRealtimeCredentials | null>;
	connect(
		credentials: ParlumeRealtimeCredentials,
	): Promise<ParlumeRealtimeSocket>;
	/** Where Parlume's voice goes: the live bot's outlet. */
	outlet(): ParlumeAuraOutlet | null;
	/** The bridge's current voice generation. */
	generation(): number;
	/** The voice floor's gate: no guest is in, not paused, before the cap. */
	maySpeak(): boolean;
	/**
	 * The meeting's last two minutes before its cap (`parlumeCapClosing`):
	 * no new response is spoken, and what waits is answered in the chat.
	 */
	closing(): boolean;
	/** Hands a request to Fabric as a meeting turn; false when Fabric refused it. */
	dispatchJob(input: {
		job: string;
		request: string;
		requester: string | null;
		/** The asker's speaker key: their participant id when the meeting gave one. */
		requesterKey: string | null;
		generation: number;
	}): Promise<boolean>;
	postChat(text: string): Promise<ParlumeRealtimeChatResult>;
	readChat(): Array<{ from: string | null; text: string }>;
	reportUsage(usage: ParlumeRealtimeUsage): void;
	/** When a job's answer was first heard, and finished or was cut short. */
	reportSpoken(input: {
		turnId: string;
		firstAudioAt: number | null;
		spokenAt: number | null;
		interrupted: boolean;
	}): void;
	/** Keeps the context a restarted bridge restores; see the engine's `restore`. */
	saveContext(context: ParlumeRealtimeContext): void;
	/** Realtime is gone for good: the meeting carries on with the classic engine. */
	fallBack(reason: string): void;
	log(
		level: "info" | "warn" | "error",
		event: string,
		meta: Record<string, unknown>,
	): void;
	now(): number;
}
