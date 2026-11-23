import type { ParlumeAuraBinding } from "./parlume-aura";
import type { ParlumeChatChannel } from "./parlume-chat-channel";
import type { ParlumeOutletReplyObserver } from "./parlume-pcm";
import type { ParlumeStreamConnection } from "./parlume-stream-auth";

// What the voice floor needs from the meeting's bridge and from a realtime
// engine that is speaking.

export type ParlumeFloorStream = Pick<
	ParlumeStreamConnection,
	"sessionId" | "botId"
>;

/** What the voice floor needs from a realtime engine that is speaking. */
export interface ParlumeRealtimeVoice {
	/** Audio of one of its responses is queued or playing. */
	isPlaying(): boolean;
	/** A response is being produced, or a Fabric job it started is running. */
	isResponding(): boolean;
	/** A Fabric job it started on this voice generation is still running. */
	hasJob(generation: number): boolean;
	/** It is saying something, or preparing an answer someone asked for. */
	holdsFloor(): boolean;
	/** Resolves once it no longer holds the floor. */
	whenQuiet(): Promise<void>;
	/**
	 * Parlume was stopped: the outlet has already dropped `droppedBytes` of
	 * queued speech. The response in progress is cancelled, one that is done
	 * but whose audio still plays included, and the engine's jobs end.
	 */
	silence(droppedBytes: number): void;
	/**
	 * Says nothing more until the release it returns is called, with whether
	 * all of `text` was said: the bridge reads it aloud meanwhile. Its jobs
	 * run on.
	 */
	holdForRead(text: string, droppedBytes: number): (said: boolean) => void;
}

export interface ParlumeVoiceFloorHost<T> {
	storage: Pick<DurableObjectStorage, "get" | "put" | "delete" | "setAlarm">;
	sessionId(): string;
	aura: ParlumeAuraBinding;
	chat: Pick<ParlumeChatChannel, "isChatTurnCurrent">;
	postToFabric(path: string, body: object): Promise<Response | null>;
	/** One line in the meeting chat. */
	postNotice(text: string): Promise<unknown>;
	/** Starts a request that waited in the queue, opening with its asker. */
	startTurn(turn: T): Promise<void>;
	/** The session's provider bot, which a stopped turn is reported for. */
	bot(): Promise<ParlumeFloorStream | null>;
	/** The stream of the bot's newest verified socket. */
	liveStream(): ParlumeFloorStream | null;
	/** The meeting has not reached its hard stop. */
	meetingOpen(): boolean;
	/** Parlume was asked to pause. */
	paused(): boolean;
	/**
	 * An external guest is in the meeting, or someone Fabric has not
	 * confirmed can read the project (`ParlumeGuests.open`).
	 */
	guestPresent(): boolean;
	/** Drops a woken request still waiting for its speaker to finish. */
	cancelEndpoint(): void;
	realtime(): ParlumeRealtimeVoice | null;
	/** Told how each reply played on the meeting's outlet, for telemetry. */
	replies: ParlumeOutletReplyObserver;
	log(
		level: "info" | "warn" | "error",
		event: string,
		meta: Record<string, unknown>,
	): void;
}
