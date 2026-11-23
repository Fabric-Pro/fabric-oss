import { type Connection, type ConnectionContext, Server } from "partyserver";
import type { Env } from "./env";
import {
	PARLUME_AUDIO_READY_MAX_WAIT_MS,
	ParlumeAudioReadiness,
} from "./parlume-audio-ready";
import type { ParlumeAuraBinding } from "./parlume-aura";
import {
	classifyParlumeStop,
	parlumeRequestAfterStop,
} from "./parlume-barge-in";
import { purgeParlumeBridge } from "./parlume-bridge-purge";
import {
	type ParlumeBridgeState,
	type ParlumeJoinNotice,
	parlumeHardStopMs,
	parlumeOpenUntil,
	parseParlumeVerifiedStream,
} from "./parlume-bridge-state";
import {
	PARLUME_CAP_DRAIN_MS,
	ParlumeCapWarnings,
	parlumeCapClosing,
} from "./parlume-cap-warnings";
import {
	PARLUME_CHAT_MAX_FIRST_NUMBER,
	type ParlumeChatMessage,
	parlumePostNotAvailableLine,
} from "./parlume-chat";
import {
	type ParlumeChatBot,
	ParlumeChatChannel,
	type ParlumeChatTurn,
} from "./parlume-chat-channel";
import {
	isParlumeContinueRequest,
	type ParlumePostAction,
	type ParlumeReplyChannel,
} from "./parlume-chat-commands";
import { parseParlumeFabricResult } from "./parlume-fabric-result";
import { ParlumeGuests, parseParlumeGuestUpdates } from "./parlume-guests";
import {
	isSpokenParlumePause,
	ParlumeLiveControls,
} from "./parlume-live-controls";
import {
	PARLUME_SPEECH_SAMPLE_RATE,
	parlumeBotOutputMessage,
} from "./parlume-pcm";
import { createParlumeRealtimeEngine } from "./parlume-realtime-bridge";
import type { ParlumeRealtimeEngine } from "./parlume-realtime-engine";
import type { ParlumeRealtimeContext } from "./parlume-realtime-host";
import { parlumeSpeakerKey, UNKNOWN_SPEAKER } from "./parlume-request-queue";
import {
	type ParlumeSpeaker,
	ParlumeSpeakerTimeline,
} from "./parlume-speakers";
import { ParlumeSpeechHealth } from "./parlume-speech-health";
import { ParlumeSpokenStop } from "./parlume-spoken-stop";
import { ParlumeStatusTile } from "./parlume-status-tile";
import {
	authenticateParlumeStreamMessage,
	isRecord,
	type ParlumeAudioMessage,
	type ParlumeStreamConnection,
	parseParlumeSpeakerUpdates,
} from "./parlume-stream-auth";
import {
	ParlumeTranscriber,
	type ParlumeTranscript,
	parlumeTranscriptTimeAt,
} from "./parlume-transcriber";
import {
	isIncompleteParlumeDictation,
	PARLUME_COMPLETE_REQUEST_QUIET_MS,
	ParlumeTurnEndpoint,
} from "./parlume-turn-endpoint";
import { ParlumeVoiceFloor } from "./parlume-voice-floor";
import {
	findParlumeWake,
	findParlumeWakeNearMiss,
	isSameParlumeRequest,
	mayNameParlumePost,
	type ParlumeSpokenReference,
	parseParlumeSpokenReference,
	parseParlumeWake,
} from "./parlume-wake";

const WATCHDOG_RETRY_MS = 5 * 60 * 1000;
const ACCESS_CHECK_MS = 60 * 1000;
const TURN_RETRY_MS = 2_000;
const FABRIC_REQUEST_TIMEOUT_MS = 15_000;
const VERIFY_BACKOFF_MS = [100, 250, 500, 1_000, 2_000, 4_000];
const PENDING_SEGMENTS_KEY = "pendingSegments";
const STREAM_CLOSED_KEY = "streamClosed";
const STREAM_ERROR_KEY = "streamError";
const WAKE_ARM_KEY = "wakeArm";
const PENDING_TURNS_KEY = "pendingTurns";
// The Durable Object is restarted now and then by Cloudflare (a runtime
// update, a host move) even mid-meeting; the realtime voice resumes from this.
const REALTIME_CONTEXT_KEY = "realtimeContext";
const REALTIME_GAVE_UP_KEY = "realtimeGaveUp";
const MAX_PENDING_SEGMENTS = 1_000;
const MAX_SEGMENTS_PER_FLUSH = 25;
// Nobody has spoken for this long and Parlume is silent: treat the meeting
// as over. The provider's own silence timeout cannot go below five minutes.
const IDLE_LEAVE_MS = 3 * 60 * 1000;
const LAST_ACTIVITY_KEY = "lastActivityAt";
const IDLE_REPORTED_KEY = "idleReported";
// Hosted Attendee does not report a Teams lobby, so a bot whose stream has
// not connected this long after the invite is taken to be waiting there.
// On staging (144 joins to 2026-11-21) a bot that got straight in streamed
// in 24 seconds at the median and 50 at the 90th percentile.
const LOBBY_CHECK_MS = 90_000;
// Flux's end-of-turn confidence for its early guess; its final needs 0.7.
const PARLUME_EAGER_EOT_THRESHOLD = "0.5";

type BridgeState = ParlumeBridgeState;

type StreamConnection = ParlumeStreamConnection;

interface PendingSegment {
	sessionId: string;
	botId: string;
	text: string;
	speakerName: string | null;
	speakerId: string | null;
	utteranceStartMs: number | null;
	utteranceEndMs: number | null;
	source?: "SPEECH" | "CHAT";
	chatMessageId?: string;
}

interface PendingTurn {
	voiceGeneration: number;
	sessionId: string;
	botId: string;
	text: string;
	speakerName: string | null;
	speakerId: string | null;
	utteranceStartMs: number | null;
	utteranceEndMs: number | null;
	replyChannel?: ParlumeReplyChannel;
	chatMessageId?: string;
	/**
	 * A spoken request heard while Parlume was answering: once its speaker
	 * has finished, it waits in the floor's queue rather than going to Fabric.
	 */
	queued?: true;
}

/** What Fabric said to a turn the bridge handed it. */
interface PostedTurn {
	accepted: boolean;
	handoffMs: number;
	/** Fabric's own steps, from when its handler started. */
	timing: unknown;
}

interface WakeArm {
	speakerKey: string;
	expiresAt: number;
}

/** How long a wake phrase said on its own waits for its speaker's request. */
const WAKE_ARM_MS = 15_000;
/**
 * How long one with no speaker waits for the next speaker's request: that
 * request may be anyone's, so only one that follows closely counts.
 */
const WAKE_UNATTRIBUTED_FOLLOW_MS = 8_000;

interface StreamClosed {
	sessionId: string;
	botId: string;
	streamGeneration: number;
}

interface StreamError {
	sessionId: string;
	botId: string;
}

/**
 * Whether a segment from this speaker is the request of an armed wake
 * phrase. A wake phrase Attendee gave no speaker is the next speaker's, said
 * a moment before: "Hey, Fabric." came with no speaker, the request four
 * seconds later with its speaker, and nothing was answered.
 */
function wakeArmMatches(armed: WakeArm, speakerKey: string): boolean {
	const now = Date.now();
	if (armed.expiresAt < now) {
		return false;
	}
	if (armed.speakerKey === speakerKey) {
		return true;
	}
	return (
		armed.speakerKey === UNKNOWN_SPEAKER &&
		now <= armed.expiresAt - WAKE_ARM_MS + WAKE_UNATTRIBUTED_FOLLOW_MS
	);
}

// Workers Logs keep these as structured fields. Ids only: never the meeting
// URL, the stream token, or transcript text.
function log(
	level: "info" | "warn" | "error",
	event: string,
	meta: Record<string, unknown>,
): void {
	console[level](`[Parlume] ${event}`, {
		component: "parlume-bridge",
		event: `parlume.bridge.${event}`,
		...meta,
	});
}

async function secretMatches(
	candidate: string | null,
	expected: string | undefined,
): Promise<boolean> {
	if (!candidate || !expected) {
		return false;
	}
	const encoder = new TextEncoder();
	const [candidateDigest, expectedDigest] = await Promise.all([
		crypto.subtle.digest("SHA-256", encoder.encode(candidate)),
		crypto.subtle.digest("SHA-256", encoder.encode(expected)),
	]);
	const a = new Uint8Array(candidateDigest);
	const b = new Uint8Array(expectedDigest);
	let mismatch = a.length ^ b.length;
	for (let index = 0; index < a.length; index++) {
		mismatch |= (a[index] ?? 0) ^ (b[index] ?? 0);
	}
	return mismatch === 0;
}

// The provider's audio clock for one bot socket: the wall-clock start of its
// first chunk. Chunks carry their own wall-clock times, the same clock the
// speaker updates use, so transcripts line up with them.
interface MeetingAudio {
	transcriber: ParlumeTranscriber;
	sampleRate: number;
	startTime: number;
	health: {
		since: number;
		chunks: number;
		maxGapMs: number;
		lastChunkAt: number;
	};
}

// How often a live bot stream reports what reached the bridge and Flux.
const AUDIO_HEALTH_LOG_MS = 10_000;

export class Parlume extends Server<Env> {
	private connections = new Map<Connection, StreamConnection>();
	private audio = new Map<Connection, MeetingAudio>();
	private speakers = new ParlumeSpeakerTimeline();
	private inFlightFinalSegments = new Set<Promise<void>>();
	private finalSegmentChain = Promise.resolve();
	private connectionGeneration = 0;
	// When the latest wake phrase was heard, for the dispatch timing log.
	private wokeAt = 0;
	// A request started on Flux's early end-of-turn, kept while its final
	// transcript is awaited.
	private eagerTurn: { request: string; generation: number } | null = null;
	private turnEndpoint = new ParlumeTurnEndpoint<PendingTurn>((turn) => {
		void this.dispatchTurn(turn);
	});
	private lastActivityAt = Date.now();
	// When the meeting's hard stop comes; null while the bridge has none.
	private openUntil: number | null = null;
	private guests = new ParlumeGuests(this.ctx.storage);
	// What the voices log about their speech also counts in the meeting's
	// speech telemetry, which the alarm reports to Fabric.
	private speech = new ParlumeSpeechHealth({
		storage: this.ctx.storage,
		sessionId: () => this.name,
		bot: () => this.chatBot(),
		postToFabric: (path, body) => this.postToFabric(path, body),
		log,
		now: () => Date.now(),
	});
	// The bot's video tile shows whether Parlume listens, is paused or answers.
	private statusTile = new ParlumeStatusTile({
		state: () =>
			this.controls.paused
				? "PAUSED"
				: this.floor.speaking || this.floor.isAnswering()
					? "ANSWERING"
					: "LISTENING",
		bot: () => this.chatBot(),
		postToFabric: (path, body) => this.postToFabric(path, body),
		log,
	});
	private speechLog = this.statusTile.observing(this.speech.observing(log));
	private chat = new ParlumeChatChannel({
		storage: this.ctx.storage,
		postToFabric: (path, body) => this.postToFabric(path, body),
		requestFabric: (path, body) => this.requestFabric(path, body),
		bot: () => this.chatBot(),
		isParlumeSender: (name) => this.isBotSpeaker(name ?? undefined),
		guests: this.guests,
		isBusy: () => this.floor.isAnswering(),
		whenSpeechSent: () => this.floor.whenSpeechSent(),
		speak: (text, asker) => this.floor.speakLocally(text, asker),
		continueReading: (actor) => this.floor.continueReading(actor),
		speakJoinNotice: (text) => this.floor.speakJoinNotice(text),
		stop: async (actor) => {
			await this.controls.stop("chat", actor);
		},
		pause: async (actor) => {
			await this.controls.pause(actor);
		},
		isStopped: (generation) => this.floor.isStopped(generation),
		dispatchTurn: (turn) => this.dispatchChatTurn(turn),
		persistSegment: (bot, message) => this.persistChatSegment(bot, message),
		noteActivity: () => this.noteActivity({ persist: true }),
		wakeAt: (at) => {
			setTimeout(
				() => void this.chat.checkDeliveries(),
				Math.max(0, at - Date.now()),
			);
		},
		log,
		now: () => Date.now(),
	});
	private floor = new ParlumeVoiceFloor<Connection, PendingTurn>({
		storage: this.ctx.storage,
		sessionId: () => this.name,
		// Workers AI's binding types cannot name Aura's raw-response overload.
		aura: this.env.AI as unknown as ParlumeAuraBinding,
		chat: this.chat,
		postToFabric: (path, body) => this.postToFabric(path, body),
		postNotice: (text) => this.chat.postNotice(text, false),
		startTurn: (turn) => this.startTurn(turn, true),
		bot: () => this.chatBot(),
		liveStream: () => this.liveStream()?.stream ?? null,
		meetingOpen: () =>
			this.openUntil !== null && Date.now() < this.openUntil,
		paused: () => this.controls.paused,
		guestPresent: () => !this.guests.open,
		// A request still being heard out to wait in the queue is not the
		// answer being stopped.
		cancelEndpoint: () => {
			if (!this.turnEndpoint.pending()?.queued) {
				this.turnEndpoint.cancel();
			}
		},
		realtime: () => this.realtimeVoice(),
		replies: this.speech,
		log: this.speechLog,
	});
	private controls = new ParlumeLiveControls({
		storage: this.ctx.storage,
		floor: this.floor,
		postNotice: (text, essential) => this.chat.postNotice(text, essential),
		dropQueued: async () => {
			this.realtime?.disarm();
			await this.ctx.storage.delete(WAKE_ARM_KEY);
		},
		bot: () => this.chatBot(),
		audioStartedAt: () => [...this.audio.values()][0]?.startTime ?? null,
		postToFabric: (path, body) => this.postToFabric(path, body),
		log: this.statusTile.observing(log),
		now: () => Date.now(),
	});
	private capWarnings = new ParlumeCapWarnings({
		storage: this.ctx.storage,
		speak: (text) => this.floor.speakNotice(text),
		postNotice: (text) => this.chat.postNotice(text, true),
		// A request the realtime voice was armed for or still holds goes to
		// the chat too.
		onClosing: () => this.realtime?.closeForCap(),
		log,
		now: () => Date.now(),
	});
	private spokenStop = new ParlumeSpokenStop({
		speaking: () => this.floor.speaking,
		stoppable: () => this.floor.speaking || this.floor.isAnswering(),
		saying: () => this.floor.saying(),
		hold: () => this.floor.holdSpeech(),
		release: () => this.floor.releaseSpeech(),
		stop: async (actor, detection) => {
			await this.controls.stop("voice", actor, detection);
		},
		log,
		now: () => Date.now(),
	});
	// Set while the realtime engine is starting or speaking; null when the
	// meeting runs on the classic engine.
	private realtime: ParlumeRealtimeEngine | null = null;
	/** Where on the audio clock the latest final transcript ended. */
	private finalHeardUntil = 0;
	// Realtime could not be started or kept up: classic for the rest of the
	// meeting, stream reconnects and restarts included.
	private realtimeGaveUp = false;
	// The welcome of a verified stream, waiting for its audio to arrive whole
	// so that a request made once Parlume says it is in is heard.
	private pendingWelcome: {
		sessionId: string;
		botId: string;
		notice: ParlumeJoinNotice | null;
		guestArrived: boolean;
		verifiedAt: number;
		readiness: ParlumeAudioReadiness;
	} | null = null;

	async onStart() {
		await this.floor.load();
		await this.speech.load();
		await this.guests.load();
		await this.controls.load();
		await this.capWarnings.load();
		const gaveUp = await this.ctx.storage.get(REALTIME_GAVE_UP_KEY);
		this.realtimeGaveUp = gaveUp === true;
		// A restart loses the in-memory clock; the stored value is refreshed on
		// every final segment, so the idle window resumes rather than restarts.
		const storedActivityAt =
			await this.ctx.storage.get<number>(LAST_ACTIVITY_KEY);
		this.lastActivityAt = storedActivityAt ?? Date.now();
		// Cloudflare resets the object now and then mid-meeting ("Durable Object
		// connection closed because the object was reset"), with no deploy and
		// no memory, CPU or exception error of ours. This counts them. The bridge
		// is stored at invite, so only a meeting that has already heard someone
		// counts as restarted.
		const bridge = await this.ctx.storage.get<BridgeState>("bridge");
		this.openUntil = parlumeOpenUntil(bridge);
		if (bridge && storedActivityAt !== undefined) {
			log("info", "bridge.restarted", {
				sessionId: bridge.sessionId,
				botId: bridge.botId,
				sinceActivityMs: Date.now() - this.lastActivityAt,
			});
		}
	}

	/**
	 * Someone in the meeting spoke or wrote in the chat, so the meeting is not
	 * idle. Every participant input goes through here; the idle leave reads
	 * nothing else. `persist` keeps the clock across a restart, skipped for
	 * partial transcripts that a final one follows within seconds.
	 */
	private async noteActivity({
		persist,
	}: {
		persist: boolean;
	}): Promise<void> {
		this.lastActivityAt = Date.now();
		if (persist) {
			await this.ctx.storage.put(LAST_ACTIVITY_KEY, this.lastActivityAt);
		}
	}

	/**
	 * Closes every socket and handles each close here, newest first so none
	 * stands in as another's replacement: a half-open socket may never deliver
	 * its own close, and the stream-closed report must not wait on one. The
	 * runtime's later onClose, if it comes, finds nothing left to do.
	 */
	private async closeStream(reason: string): Promise<number> {
		const open = [...this.connections.keys()].reverse();
		for (const connection of open) {
			connection.close(1000, reason);
		}
		for (const connection of open) {
			await this.onClose(connection, 1000, reason);
		}
		return open.length;
	}

	async onConnect(conn: Connection, ctx: ConnectionContext) {
		const url = new URL(ctx.request.url);
		const token = url.searchParams.get("token");
		if (
			!token ||
			!this.env.AGENT_SERVICE_SECRET ||
			!this.env.FABRIC_API_URL
		) {
			conn.close(4001, "Unauthorized");
			return;
		}
		this.connections.set(conn, {
			sessionId: this.name,
			token,
			botId: null,
			verified: false,
			verification: null,
			generation: ++this.connectionGeneration,
			streamGeneration: null,
		});
	}

	// Attendee's socket carries JSON text both ways; anything binary is not its.
	async onMessage(
		conn: Connection,
		message: string | ArrayBuffer | ArrayBufferView,
	) {
		if (typeof message !== "string") {
			return;
		}
		const authenticated = await authenticateParlumeStreamMessage(
			{
				connections: this.connections,
				verifyStreamWithRetry: async (state, botId) => {
					// The bot connecting again holds its speech for this socket.
					this.floor.joinSocket(conn, botId);
					const verified = await this.verifyStreamWithRetry(
						state,
						botId,
					);
					if (!verified) {
						this.floor.releaseSocket(conn);
						return false;
					}
					this.dropSupersededStreams(state);
					this.floor.bindSocket(conn, botId, (frame) =>
						conn.send(
							parlumeBotOutputMessage(
								frame,
								PARLUME_SPEECH_SAMPLE_RATE,
							),
						),
					);
					void this.startRealtime(state.sessionId, botId);
					return true;
				},
			},
			conn,
			message,
		);
		// Chunks that waited out the stream's verification can outlive the socket.
		if (!authenticated || !this.connections.has(conn)) {
			return;
		}
		this.receiveAudio(conn, authenticated.state, authenticated.message);
	}

	private receiveAudio(
		conn: Connection,
		state: StreamConnection,
		message: ParlumeAudioMessage,
	): void {
		const chunkMs = (message.pcm.length / 2 / message.sampleRate) * 1000;
		this.noteWelcomeAudio({ chunkMs, atMs: message.timestampMs });
		// Paused, Parlume hears nothing: no audio reaches Flux or realtime.
		if (this.controls.paused) {
			return;
		}
		// Attendee stamps a chunk when it packages it, after the audio happened.
		const epochMs = message.timestampMs - chunkMs;
		let audio = this.audio.get(conn);
		if (audio?.sampleRate !== message.sampleRate) {
			audio = this.startMeetingAudio(
				conn,
				state,
				message.sampleRate,
				epochMs,
			);
		}
		audio.transcriber.send(message.pcm.buffer, epochMs);
		// Flux keeps the transcript; the realtime session hears the same audio.
		this.realtime?.appendAudio(message.pcm, message.sampleRate);
		this.trackAudioHealth(state, audio);
	}

	private trackAudioHealth(state: StreamConnection, audio: MeetingAudio) {
		const now = Date.now();
		const health = audio.health;
		health.chunks++;
		if (health.lastChunkAt) {
			health.maxGapMs = Math.max(
				health.maxGapMs,
				now - health.lastChunkAt,
			);
		}
		health.lastChunkAt = now;
		if (now - health.since < AUDIO_HEALTH_LOG_MS) {
			return;
		}
		log("info", "audio.health", {
			sessionId: state.sessionId,
			botId: state.botId,
			windowMs: now - health.since,
			chunks: health.chunks,
			maxGapMs: health.maxGapMs,
			...audio.transcriber.takeStats(),
		});
		health.since = now;
		health.chunks = 0;
		health.maxGapMs = 0;
	}

	private startMeetingAudio(
		conn: Connection,
		state: StreamConnection,
		sampleRate: number,
		startTime: number,
	): MeetingAudio {
		this.audio.get(conn)?.transcriber.close();
		const meta = { sessionId: state.sessionId, botId: state.botId };
		const audio: MeetingAudio = {
			sampleRate,
			startTime,
			health: {
				since: Date.now(),
				chunks: 0,
				maxGapMs: 0,
				lastChunkAt: 0,
			},
			transcriber: new ParlumeTranscriber({
				sampleRate,
				connect: () => this.openTranscription(sampleRate),
				onTranscript: (transcript) => {
					void this.handleTranscript(conn, state, transcript);
				},
				onStatus: (status, detail) =>
					log(
						status === "connected" ? "info" : "warn",
						`transcriber.${status}`,
						{
							...meta,
							detail,
						},
					),
			}),
		};
		this.audio.set(conn, audio);
		log("info", "audio.started", { ...meta, sampleRate });
		return audio;
	}

	private async openTranscription(sampleRate: number) {
		const response = await this.env.AI.run(
			"@cf/deepgram/flux",
			{
				encoding: "linear16",
				sample_rate: String(sampleRate),
				keyterm: "Parlume",
				// Flux's early end-of-turn lets a request start before Flux is
				// sure the speaker has finished (see `startEagerTurn`).
				eager_eot_threshold: PARLUME_EAGER_EOT_THRESHOLD,
			},
			{ websocket: true },
		);
		if (!response.webSocket) {
			throw new Error(
				`Workers AI returned HTTP ${response.status} instead of a transcription stream.`,
			);
		}
		return response.webSocket;
	}

	private async handleTranscript(
		conn: Connection,
		state: StreamConnection,
		transcript: ParlumeTranscript,
	): Promise<void> {
		const audio = this.audio.get(conn);
		// Words Flux returns after a pause began are not kept.
		if (!state.botId || !audio || this.controls.paused) {
			return;
		}
		if (transcript.isFinal) {
			this.finalHeardUntil = Math.max(
				this.finalHeardUntil,
				transcript.endMs,
			);
		}
		const speaker = this.speakers.attribute(
			transcript.startMs,
			transcript.endMs,
		);
		const speakerName = speaker?.name ?? null;
		const speakerId = speaker?.id ?? null;
		const fromBot = this.isBotSpeaker(speakerName ?? undefined);
		const asker = this.requestSpeaker(transcript, speaker);
		const askerName = asker?.name ?? null;
		const askerKey = parlumeSpeakerKey(asker?.id ?? null, askerName);
		const askedBy = { name: askerName, id: asker?.id ?? null };
		const askedByBot = fromBot || this.isBotSpeaker(askerName ?? undefined);
		if (!fromBot) {
			await this.noteActivity({ persist: transcript.isFinal });
			if (transcript.isFinal && this.chat.noteSpeechSegment()) {
				await this.wakeForSuggestionPass();
			}
		}
		const realtime = this.answeringRealtime();
		const segment: PendingSegment = {
			sessionId: state.sessionId,
			botId: state.botId,
			text: transcript.text,
			speakerName,
			speakerId,
			// Fabric stores whole milliseconds from the start of capture.
			utteranceStartMs: Math.max(
				0,
				Math.round(transcript.startMs - audio.startTime),
			),
			utteranceEndMs: Math.max(
				0,
				Math.round(transcript.endMs - audio.startTime),
			),
		};
		// The transcript keeps the turn's speaker; a request is the asker's.
		const request: PendingSegment = {
			...segment,
			speakerName: askerName,
			speakerId: asker?.id ?? null,
		};
		if (transcript.tentative) {
			if (!realtime && !askedByBot) {
				await this.onTentativeEnd(
					state,
					request,
					transcript.tentative,
					askerKey,
				);
			}
			return;
		}
		if (!transcript.isFinal) {
			// Transcripts are handled concurrently: a partial of an utterance
			// whose final was already handled must not stop the answer to it.
			// While a request is being endpointed, its speaker's continued
			// words extend it; Flux's empty start-of-turn events carry none.
			if (
				transcript.endMs > this.finalHeardUntil &&
				!fromBot &&
				transcript.text
			) {
				this.floor.requests.noteHeard(true);
				this.turnEndpoint.hold(askerKey);
				this.spokenStop.onPartial(
					transcript.text,
					asker,
					transcript.endMs,
				);
			}
			const partialWake =
				realtime && !askedByBot
					? parseParlumeWake(transcript.text)
					: null;
			if (
				realtime &&
				!fromBot &&
				(classifyParlumeStop(transcript.text, false) !== "none" ||
					isSpokenParlumePause(transcript.text))
			) {
				realtime.disarm();
			} else if (
				realtime &&
				partialWake !== null &&
				!mayNameParlumePost(partialWake) &&
				!this.continuesReading(partialWake) &&
				// Transcripts are handled concurrently: a partial of an
				// utterance whose final was already answered must not arm
				// Parlume again.
				transcript.endMs > this.finalHeardUntil
			) {
				realtime.arm({
					requester: askerName,
					speakerKey: askerKey,
					request: partialWake,
					endOfTurn: false,
				});
			}
			return;
		}
		// The request already started on Flux's early end-of-turn: it is not
		// started again, and does not barge in on its own answer.
		const eagerKept =
			!fromBot &&
			!realtime &&
			(await this.settleEagerTurn(state, segment));
		const pausing = !fromBot && isSpokenParlumePause(segment.text);
		// Only a stop ends Parlume's answer: any other words, its requester's
		// included, let it go on. Parlume's own words are never a stop, and
		// still end a hold that their partial, not yet named, began.
		const stop = await this.spokenStop.onFinal(
			fromBot ? "" : segment.text,
			asker,
			transcript.endMs,
		);
		if (!fromBot) {
			this.floor.requests.noteHeard(false);
		}
		const wake = fromBot ? null : parseParlumeWake(segment.text);
		if (eagerKept) {
			log("info", "turn.eager_kept", {
				sessionId: state.sessionId,
				botId: state.botId,
				speakerId,
			});
		} else if (pausing) {
			await this.controls.pause(askedBy);
		} else if (wake !== null && this.continuesReading(wake)) {
			// "Parlume, continue" while a chapter waits reads it, and is no
			// request of its own.
			realtime?.disarm();
			await this.floor.continueReading(askedBy);
		} else if (stop === "stop") {
			// A stop is never a request of its own, even one that opened with
			// Parlume's name and armed the realtime voice.
			realtime?.disarm();
		} else if (stop === "stop-then-request") {
			realtime?.disarm();
			await this.askAfterStop(request, askerKey);
		} else if (!fromBot) {
			if (!askedByBot) {
				await this.logWakeNearMiss(request, askerKey);
			}
			// A new request never replaces the one being answered: it waits
			// for it (`beginWakeTurn`), and the realtime voice queues its own.
			if (realtime) {
				// The realtime voice heard the request itself; Flux only says
				// that it was addressed to Parlume, and that it has ended.
				realtime.noteLine(speakerName, segment.text);
				const resolved = await this.resolveWakeTurn(request);
				const reference =
					resolved && parseParlumeSpokenReference(resolved.text);
				const action = reference
					? await this.postReferenceAction(request, reference)
					: null;
				if (action?.kind === "speak") {
					void this.floor.speakLocally(action.text, askedBy);
				} else if (action?.kind === "ask") {
					void realtime.respondToRequest(
						askerName,
						askerKey,
						action.text,
					);
				} else if (reference) {
					// As in the classic voice: the fixed line is read, and the
					// voice is never armed to answer the tag itself.
					void this.floor.speakLocally(
						parlumePostNotAvailableLine(reference.tag),
						askedBy,
					);
				} else if (resolved !== null) {
					realtime.arm({
						requester: askerName,
						speakerKey: askerKey,
						request: resolved.text,
						endOfTurn: true,
					});
				} else if (!askedByBot && wake !== null) {
					// A wake phrase on its own armed its request: the voice
					// answers that request when it comes, not the wake phrase.
					realtime.awaitRequest({
						requester: askerName,
						speakerKey: askerKey,
						forMs: WAKE_ARM_MS,
					});
				}
			} else if (
				wake !== null &&
				parseParlumeSpokenReference(wake) === null &&
				this.turnEndpoint.heldFor(askerKey)
			) {
				await this.restartHeldRequest(state, askerKey);
				await this.beginWakeTurn(request, askerKey);
			} else if (
				!this.turnEndpoint.append(
					askerKey,
					segment.text,
					segment.utteranceEndMs,
				)
			) {
				await this.beginWakeTurn(request, askerKey);
			} else {
				log("info", "turn.extended", {
					sessionId: state.sessionId,
					botId: state.botId,
					speakerId,
				});
			}
		}
		const persist = this.queueFinalSegment(segment);
		this.inFlightFinalSegments.add(persist);
		try {
			await persist;
		} finally {
			this.inFlightFinalSegments.delete(persist);
		}
	}

	private releaseConnection(conn: Connection): StreamConnection | undefined {
		this.audio.get(conn)?.transcriber.close();
		this.audio.delete(conn);
		this.floor.releaseSocket(conn);
		const state = this.connections.get(conn);
		this.connections.delete(conn);
		return state;
	}

	/**
	 * The provider reconnects when it gives up on a socket, and the old socket
	 * does not always report a close here. Once a newer stream is verified,
	 * every older one is forgotten, so it can neither stand in as the newer
	 * stream's replacement when that one closes nor count as an open socket.
	 */
	private dropSupersededStreams(current: StreamConnection): void {
		for (const [conn, state] of [...this.connections]) {
			if (state.generation < current.generation) {
				this.releaseConnection(conn);
				log("info", "stream.superseded", {
					sessionId: this.name,
					botId: state.botId,
					verified: state.verified,
				});
			}
		}
	}

	// partyserver hands a socket that fails to onError, never to onClose.
	async onError(conn: Connection, error: unknown) {
		await this.onClose(
			conn,
			1006,
			error instanceof Error ? error.message : "error",
		);
	}

	async onClose(conn: Connection, code?: number, reason?: string) {
		const state = this.releaseConnection(conn);
		log("info", "stream.closed", {
			sessionId: this.name,
			botId: state?.botId ?? null,
			verified: state?.verified ?? false,
			code,
			reason,
			remainingConnections: this.connections.size,
		});
		if (state?.verified && state.botId && state.streamGeneration !== null) {
			const hasReplacementConnection = [
				...this.connections.values(),
			].some(
				(connection) =>
					connection.sessionId === state.sessionId &&
					(!connection.verified || connection.botId === state.botId),
			);
			if (hasReplacementConnection) {
				return;
			}
			await this.floor.interrupt(state);
			this.realtime?.stop("stream_closed");
			this.realtime = null;
			await Promise.all(this.inFlightFinalSegments);
			// A replacement can connect while final segments drain. Its onConnect
			// advances this generation before verification clears close markers, so
			// this older socket must not write a stale stream-closed event afterward.
			if (state.generation !== this.connectionGeneration) {
				return;
			}
			if (await this.reportStreamFailure()) {
				return;
			}
			await this.ctx.storage.put<StreamClosed>(STREAM_CLOSED_KEY, {
				sessionId: state.sessionId,
				botId: state.botId,
				streamGeneration: state.streamGeneration,
			});
			await this.flushPendingSegments();
			await this.reportClosedStreamIfDrained();
		}
	}

	async onRequest(request: Request): Promise<Response> {
		if (request.method !== "POST") {
			return new Response("Method not allowed", { status: 405 });
		}
		if (
			!(await secretMatches(
				request.headers.get("Authorization"),
				this.env.AGENT_SERVICE_SECRET
					? `Bearer ${this.env.AGENT_SERVICE_SECRET}`
					: undefined,
			))
		) {
			return Response.json({ error: "Unauthorized" }, { status: 401 });
		}
		const action = new URL(request.url).searchParams.get("action");
		if (action === "speak") {
			return this.floor.speak(request);
		}
		if (action === "say") {
			return this.floor.say(request);
		}
		if (action === "stop") {
			return this.stop(request);
		}
		if (action === "close") {
			// Fabric learned from the provider that the bot is gone (removed by
			// the host, meeting ended). Closing the socket here lets onClose
			// drain buffered segments and report the stream closed, instead of
			// waiting for a close the provider may never send. The provider's
			// webhook is waiting on this answer, so the drain and the reports to
			// Fabric run on after it.
			const closed = this.connections.size;
			this.ctx.waitUntil(this.closeStream("meeting ended"));
			log("info", "stream.close_requested", {
				sessionId: this.name,
				closed,
			});
			return Response.json({ closed });
		}
		if (action === "chat") {
			const sent = await this.chat.send(
				await request.json().catch(() => null),
			);
			// A chat answer's final post ends its turn: the next may start.
			this.floor.requests.pump();
			return sent;
		}
		if (action === "leaving") {
			return this.chat.leaving(await request.json().catch(() => null));
		}
		if (action === "purge") {
			return this.purge();
		}
		if (action === "chat-message") {
			return this.chat.receive(await request.json().catch(() => null));
		}
		if (action === "speakers") {
			return this.updateSpeakers(request);
		}
		if (action === "guests") {
			return this.updateGuests(request);
		}
		if (
			action === "stop-speech" ||
			action === "pause" ||
			action === "resume" ||
			action === "continue-reading" ||
			action === "read-aloud"
		) {
			return this.controls.control(
				action,
				await request.json().catch(() => null),
			);
		}
		if (action === "fabric-result") {
			const result = parseParlumeFabricResult(
				await request.json().catch(() => null),
			);
			if (!result) {
				return Response.json(
					{ error: "Invalid result" },
					{ status: 400 },
				);
			}
			return Response.json({
				// A result survives a reconnect: the engine speaks it once the
				// new session is up.
				accepted: this.realtime?.deliverResult(result) === true,
			});
		}
		if (action === "verify-generation") {
			const body: unknown = await request.json();
			const state =
				isRecord(body) && typeof body.voiceGeneration === "number"
					? this.floor.generationState(
							body.voiceGeneration,
							typeof body.replyId === "string"
								? body.replyId
								: null,
						)
					: { current: false };
			return Response.json({
				...state,
				chatAvailable: await this.chat.isAvailable(),
			});
		}
		let body: unknown;
		try {
			body = await request.json();
		} catch {
			return Response.json({ error: "Invalid request" }, { status: 400 });
		}
		if (!isRecord(body) || typeof body.hardStopAt !== "string") {
			return Response.json({ error: "Invalid request" }, { status: 400 });
		}
		const hardStopAt = new Date(body.hardStopAt);
		if (
			Number.isNaN(hardStopAt.getTime()) ||
			hardStopAt.getTime() <= Date.now()
		) {
			return Response.json(
				{ error: "Invalid hard stop" },
				{ status: 400 },
			);
		}
		await this.saveBridge({
			sessionId: this.name,
			botId: null,
			hardStopAt: hardStopAt.toISOString(),
		});
		// Absent from a Fabric that does not count earlier sessions' tags.
		if (
			typeof body.chatTagStart === "number" &&
			Number.isSafeInteger(body.chatTagStart) &&
			body.chatTagStart >= 1 &&
			body.chatTagStart <= PARLUME_CHAT_MAX_FIRST_NUMBER
		) {
			await this.chat.startTagsAt(body.chatTagStart);
		}
		await this.ctx.storage.setAlarm(
			Math.min(hardStopAt.getTime(), Date.now() + LOBBY_CHECK_MS),
		);
		return Response.json({ armed: true });
	}

	// Attendee reports who is speaking by webhook, not on the audio socket, so
	// Fabric relays each update here.
	private async updateSpeakers(request: Request): Promise<Response> {
		const updates = parseParlumeSpeakerUpdates(
			await request.json().catch(() => null),
		);
		if (!updates) {
			return Response.json(
				{ error: "Invalid speaker updates" },
				{ status: 400 },
			);
		}
		this.speakers.update(updates);
		return Response.json({ accepted: updates.length });
	}

	// Fabric relays each join and leave from Attendee's webhook, and where it
	// is with checking each participant. When Parlume may no longer answer,
	// the voice stops before this answers.
	private async updateGuests(request: Request): Promise<Response> {
		const relay = parseParlumeGuestUpdates(
			await request.json().catch(() => null),
		);
		if (!relay) {
			return Response.json(
				{ error: "Invalid guest updates" },
				{ status: 400 },
			);
		}
		const changed = await this.guests.update(relay);
		if (changed.guestArrived) {
			void this.guestArrived(false);
		} else if (changed.closed) {
			void this.floor.stop("guest");
		} else if (changed.opened) {
			void this.chat.postHeldRecap();
		}
		log("info", "guests.updated", {
			sessionId: this.name,
			joined: relay.updates.filter((update) => update.joined).length,
			left: relay.updates.filter((update) => !update.joined).length,
			checking: relay.placing.filter((placed) => placed.pending).length,
			present: this.guests.present,
			open: this.guests.open,
		});
		return Response.json({
			accepted: relay.updates.length + relay.placing.length,
		});
	}

	private isBotSpeaker(name: string | undefined): boolean {
		return Boolean(name && /^Fabric Parlume\b/i.test(name));
	}

	/** "Parlume, continue" while a chapter of a read waits to be asked for. */
	private continuesReading(request: string): boolean {
		return (
			this.floor.requests.chapterWaiting &&
			isParlumeContinueRequest(request)
		);
	}

	/**
	 * A speaker who addresses Parlume again while their request is still being
	 * heard out starts over: that request is dropped, with the reply begun for
	 * it unless it was waiting its turn.
	 */
	private async restartHeldRequest(
		state: StreamConnection,
		speakerKey: string,
	): Promise<void> {
		const held = this.turnEndpoint.heldFor(speakerKey);
		this.turnEndpoint.cancel();
		if (held && !held.queued) {
			await this.floor.interrupt(state);
		}
	}

	/**
	 * Who addressed Parlume: whoever spoke from the wake phrase on. Flux runs
	 * two speakers into one turn when the second starts before the first has
	 * finished, so the name can come partway through a turn the first began.
	 * Without word times that match the text, the turn's speaker asked.
	 */
	private requestSpeaker(
		transcript: ParlumeTranscript,
		turnSpeaker: ParlumeSpeaker | null,
	): ParlumeSpeaker | null {
		const wake = findParlumeWake(transcript.text);
		const wakeMs = wake?.offset
			? parlumeTranscriptTimeAt(transcript, wake.offset)
			: null;
		return wakeMs === null
			? turnSpeaker
			: (this.speakers.attribute(wakeMs, transcript.endMs) ??
					turnSpeaker);
	}

	// The bridge knows the session's provider bot; Fabric holds the provider key.
	private async chatBot(): Promise<ParlumeChatBot | null> {
		const bridge = await this.ctx.storage.get<BridgeState>("bridge");
		return bridge?.botId
			? { sessionId: bridge.sessionId, botId: bridge.botId }
			: null;
	}

	/** The bot's newest verified socket: the one Parlume's speech goes to. */
	private liveStream(): {
		connection: Connection;
		stream: StreamConnection;
	} | null {
		const [live] = [...this.connections]
			.filter(([, state]) => state.verified && state.botId)
			.sort(([, a], [, b]) => b.generation - a.generation);
		return live ? { connection: live[0], stream: live[1] } : null;
	}

	// Chat lines sit in the transcript at the time they were sent, on the same
	// clock as the speech around them.
	private persistChatSegment(
		bot: ParlumeChatBot,
		message: ParlumeChatMessage,
	): void {
		if (this.controls.paused) {
			return;
		}
		const audio = [...this.audio.values()][0];
		const offsetMs =
			audio && message.timestampMs !== null
				? Math.min(
						14_400_000,
						Math.max(
							0,
							Math.round(message.timestampMs - audio.startTime),
						),
					)
				: null;
		void this.queueFinalSegment({
			...bot,
			text: message.text,
			speakerName: message.senderName,
			speakerId: message.senderId,
			utteranceStartMs: offsetMs,
			utteranceEndMs: offsetMs,
			source: "CHAT",
			chatMessageId: message.id,
		});
	}

	/**
	 * The realtime engine while a session is open. Until it first connects, and
	 * while it reconnects, it cannot hear the meeting, so the classic voice
	 * answers instead of a request going unheard.
	 */
	private realtimeVoice(): ParlumeRealtimeEngine | null {
		return this.realtime?.connected ? this.realtime : null;
	}

	/**
	 * The meeting's last two minutes before its cap, and after it: Parlume
	 * starts no spoken answer, and answers each request in the chat.
	 */
	private capClosing(): boolean {
		return parlumeCapClosing(this.openUntil, Date.now());
	}

	/**
	 * The realtime voice, while it may take a new request: in the last two
	 * minutes the classic route answers it in the chat instead.
	 */
	private answeringRealtime(): ParlumeRealtimeEngine | null {
		return this.capClosing() ? null : this.realtimeVoice();
	}

	/**
	 * Chooses the meeting's voice once its stream is verified: realtime when
	 * Fabric can mint a session on the realtime deployment the organization
	 * named, classic otherwise, and classic for good once realtime cannot be
	 * started or kept up, or a guest is in.
	 */
	private async startRealtime(sessionId: string, botId: string) {
		if (this.realtime || this.realtimeGaveUp || this.guests.present) {
			return;
		}
		const engine = createParlumeRealtimeEngine({
			sessionId,
			botId,
			postToFabric: (path, body) => this.postToFabric(path, body),
			segmentsSent: () => this.finalSegmentChain,
			outlet: () => this.floor.meetingOutlet(),
			generation: () => this.floor.generation,
			maySpeak: () => this.floor.maySpeak(),
			closing: () => this.capClosing(),
			attendees: () => this.guests.attendees(),
			userFor: (speakerKey) => this.guests.userFor(speakerKey),
			chat: this.chat,
			saveContext: (context) =>
				void this.ctx.storage.put(REALTIME_CONTEXT_KEY, context),
			fallBack: (stopped, reason) => {
				if (this.realtime === stopped) {
					this.realtime = null;
					this.giveUpRealtime();
					this.speechLog("warn", "engine.fallback", {
						sessionId,
						botId,
						engine: "classic",
						reason,
					});
				}
			},
			log: this.speechLog,
		});
		this.realtime = engine;
		const saved =
			await this.ctx.storage.get<ParlumeRealtimeContext>(
				REALTIME_CONTEXT_KEY,
			);
		if (saved) {
			engine.restore(saved);
		}
		const started = await engine.start();
		if (this.realtime !== engine) {
			engine.stop("superseded");
			return;
		}
		// Not asked again on a provider reconnect: a failed start is almost
		// always Fabric's lasting classic answer (no key, OpenAI refused it),
		// and the bridge cannot tell it from a passing failure.
		if (!started.ok) {
			this.realtime = null;
			this.giveUpRealtime();
		}
		log("info", "engine", {
			sessionId,
			botId,
			engine: started.ok ? "realtime" : "classic",
			reason: started.ok ? null : started.reason,
		});
		// Fabric minted a session the bridge could not open: realtime was
		// meant to speak, and the classic voice does instead.
		if (!started.ok && started.reason === "connect_failed") {
			this.speechLog("warn", "engine.fallback", {
				sessionId,
				botId,
				engine: "classic",
				reason: started.reason,
			});
		}
	}

	/** Classic for the rest of the meeting, a restart of the bridge included. */
	private giveUpRealtime(): void {
		this.realtimeGaveUp = true;
		void this.ctx.storage.put(REALTIME_GAVE_UP_KEY, true);
	}

	/**
	 * A request typed in the chat never cuts what Parlume is saying or
	 * answering: it waits in the floor's queue, behind any request before it,
	 * for that answer to end. Its reply goes to the chat unless it asked to be
	 * said aloud. With the realtime engine, a spoken reply is the realtime
	 * voice's own, which queues it behind what it is saying.
	 */
	private async dispatchChatTurn(request: ParlumeChatTurn): Promise<void> {
		const bot = await this.chatBot();
		// Paused, Parlume answers nothing until a member resumes it.
		if (!bot || this.controls.paused) {
			return;
		}
		const realtime = this.answeringRealtime();
		if (realtime && request.replyChannel === "VOICE") {
			log("info", "chat.turn", {
				...bot,
				replyChannel: request.replyChannel,
				engine: "realtime",
				requestChars: request.text.length,
			});
			await realtime.respondToChat(
				request.speakerName,
				request.text,
				request.speakerId,
			);
			return;
		}
		this.wokeAt = Date.now();
		const waiting = this.floor.requests.mustWait;
		log("info", "chat.turn", {
			...bot,
			replyChannel: request.replyChannel,
			requestChars: request.text.length,
			waiting,
		});
		const turn: PendingTurn = {
			...bot,
			voiceGeneration: this.floor.generation,
			text: request.text,
			speakerName: request.speakerName,
			speakerId: request.speakerId,
			utteranceStartMs: null,
			utteranceEndMs: null,
			replyChannel: request.replyChannel,
			chatMessageId: request.chatMessageId,
		};
		if (waiting) {
			await this.floor.requests.turn(turn, {
				name: request.speakerName,
				id: request.speakerId,
			});
			return;
		}
		await this.startTurn(turn, false);
	}

	/**
	 * A request's turn, now or once the requests before it were answered. A
	 * chat reply takes the current voice generation, so it starts no new one
	 * and supersedes nothing; a spoken reply begins its own, for its asker,
	 * and one that waited opens with their name (`greet`). Fabric runs one
	 * turn at a time, so a turn it still holds sends this one back to wait,
	 * as any other. In the last two minutes before the cap, every request is
	 * answered in the chat, those that waited included.
	 */
	private async startTurn(turn: PendingTurn, greet: boolean): Promise<void> {
		const replyChannel = this.capClosing() ? "CHAT" : turn.replyChannel;
		const generation =
			replyChannel === "CHAT"
				? this.floor.generation
				: await this.floor.beginReply(true, turn.speakerName, greet);
		if (replyChannel === "CHAT") {
			this.chat.beginChatTurn(generation);
		}
		await this.dispatchTurn({
			...turn,
			replyChannel,
			queued: undefined,
			voiceGeneration: generation,
		});
	}

	private async stop(_request: Request): Promise<Response> {
		const bridge = await this.ctx.storage.get<BridgeState>("bridge");
		if (!bridge?.botId) {
			return Response.json(
				{ error: "Meeting stream unavailable" },
				{ status: 409 },
			);
		}
		await this.ctx.storage.put<StreamError>(STREAM_ERROR_KEY, {
			sessionId: bridge.sessionId,
			botId: bridge.botId,
		});
		await this.reportStreamFailure();
		return Response.json({ accepted: true });
	}

	async onAlarm() {
		const bridge = await this.ctx.storage.get<BridgeState>("bridge");
		if (!bridge) {
			return;
		}
		// No stream yet, before the hard stop: the lobby check the arm set.
		// A stream that connects first moves the alarm on and names its bot.
		const hardStop = parlumeHardStopMs(bridge);
		if (bridge.botId === null && Date.now() < hardStop) {
			const reported = await this.postToFabric(
				"/api/internal/parlume/lobby",
				{ sessionId: bridge.sessionId },
			);
			log(reported ? "info" : "warn", "lobby.reported", {
				sessionId: bridge.sessionId,
				accepted: Boolean(reported),
			});
			await this.ctx.storage.setAlarm(hardStop);
			return;
		}
		// Past the cap nothing more is heard: what was playing ends at its
		// sentence end, within five seconds, before the watchdog is told.
		if (this.floor.stopCause() === "cap" && this.floor.speaking) {
			await this.floor.finishAtCap(PARLUME_CAP_DRAIN_MS);
		}
		const reportsFlushed = await this.controls.flushReports();
		await this.speech.report();
		if (!(await this.floor.flushPendingInterrupt())) {
			return;
		}
		if (await this.reportStreamFailure()) {
			return;
		}
		const access = await this.verifyInviterAccess(bridge);
		if (access !== "active") {
			const hardStopAt = parlumeHardStopMs(bridge);
			if (access === "stopped") {
				// No welcome for a session that is ending.
				this.pendingWelcome = null;
				// Capture is over on Fabric's side; close now so the stream-closed
				// report and finalization do not wait for the provider.
				const closed = await this.closeStream("capture stopped");
				log("info", "access.stopped", {
					sessionId: bridge.sessionId,
					botId: bridge.botId,
					closed,
				});
				// A stream-closed report the close could not deliver is retried
				// on the watchdog cadence. Otherwise the access check goes on
				// every minute: once the provider reports the bot gone, it
				// lets Fabric finalize a session whose stream close never
				// reached it, and Fabric's purge on finalizing ends the checks.
				const flushed = await this.flushPendingSegments();
				if (flushed) {
					await this.reportClosedStreamIfDrained();
				}
				if (
					!flushed ||
					(await this.ctx.storage.get<StreamClosed>(
						STREAM_CLOSED_KEY,
					))
				) {
					await this.schedulePendingRetry(hardStopAt);
				} else if (
					Number.isFinite(hardStopAt) &&
					Date.now() < hardStopAt
				) {
					await this.ctx.storage.setAlarm(
						Math.min(hardStopAt, Date.now() + ACCESS_CHECK_MS),
					);
				}
			}
			return;
		}
		// Once access is confirmed: a stream whose audio stopped, or never
		// came, still gets its welcome by its deadline.
		this.noteWelcomeAudio(null);
		await this.reportIdleMeeting(bridge);
		await this.chat.checkDeliveries();
		const suggestions = this.suggestionsEnabled(bridge);
		const audience = bridge.suggestionAudience ?? "MEETING";
		await this.chat.runSuggestionPass({
			enabled: suggestions,
			audience,
			pageUrl: bridge.pageUrl ?? null,
		});
		const [flushed, turnsFlushed] = await Promise.all([
			this.flushPendingSegments(),
			this.flushPendingTurns(),
		]);
		// A request waiting on a chat answer that never posted its last part,
		// or kept through a restart, gets its turn.
		this.floor.requests.pump();
		if (flushed) {
			await this.reportClosedStreamIfDrained();
		}
		const hardStopAt = parlumeHardStopMs(bridge);
		if (Number.isFinite(hardStopAt) && Date.now() < hardStopAt) {
			await this.capWarnings.run(hardStopAt);
			await this.statusTile.sync();
			const retryDelay = !flushed
				? WATCHDOG_RETRY_MS
				: !turnsFlushed
					? TURN_RETRY_MS
					: ACCESS_CHECK_MS;
			const chatWakeAt = await this.chat.nextWakeAt({
				suggestions,
				audience,
			});
			await this.ctx.storage.setAlarm(
				Math.min(
					hardStopAt,
					Date.now() + retryDelay,
					chatWakeAt ?? Number.POSITIVE_INFINITY,
					this.welcomeDueAt(),
					this.capWarnings.nextAt(hardStopAt) ??
						Number.POSITIVE_INFINITY,
				),
			);
			return;
		}
		const response = await this.postToFabric(
			"/api/internal/parlume/watchdog",
			{
				sessionId: bridge.sessionId,
			},
		);
		const reportsSettled =
			reportsFlushed || (await this.controls.dropReportsWithoutBot());
		if (!response || !flushed || !turnsFlushed || !reportsSettled) {
			await this.ctx.storage.setAlarm(Date.now() + WATCHDOG_RETRY_MS);
			return;
		}
		await purgeParlumeBridge(this.ctx.storage);
		this.openUntil = null;
		log("info", "bridge.purged", {
			sessionId: bridge.sessionId,
			reason: "hard_stop",
		});
	}

	// Fabric finalized the session, or a member deleted it: nothing the bridge
	// holds is needed any more. Refused while a stream is still connected,
	// which would keep writing; the hard-stop alarm stays the backstop.
	private async purge(): Promise<Response> {
		if (this.connections.size > 0) {
			log("warn", "bridge.purge_refused", {
				sessionId: this.name,
				connections: this.connections.size,
			});
			return Response.json({ purged: false }, { status: 409 });
		}
		// The speech telemetry since the last alarm, before it is gone.
		await this.speech.report();
		await purgeParlumeBridge(this.ctx.storage);
		this.openUntil = null;
		log("info", "bridge.purged", {
			sessionId: this.name,
			reason: "fabric",
		});
		return Response.json({ purged: true });
	}

	private suggestionsEnabled(bridge: BridgeState): boolean {
		return bridge.suggestionsEnabled === true && this.liveStream() !== null;
	}

	// The alarm otherwise runs on the access-check cadence, which would leave a
	// due suggestion pass waiting up to a minute after the remark it answers.
	// Only an alarm already set is brought forward: none means the bridge is
	// shutting down.
	private async wakeForSuggestionPass(): Promise<void> {
		const bridge = await this.ctx.storage.get<BridgeState>("bridge");
		if (!bridge || !this.suggestionsEnabled(bridge)) {
			return;
		}
		const [wakeAt, alarm] = await Promise.all([
			this.chat.nextWakeAt({
				suggestions: true,
				audience: bridge.suggestionAudience ?? "MEETING",
			}),
			this.ctx.storage.getAlarm(),
		]);
		if (wakeAt !== null && alarm !== null && wakeAt < alarm) {
			await this.ctx.storage.setAlarm(wakeAt);
		}
	}

	// Runs on the access-check cadence, so a silent meeting is reported within
	// one minute of crossing the idle window. Fabric asks the provider to leave;
	// the terminal callback then ends the session as usual.
	private async reportIdleMeeting(bridge: BridgeState): Promise<void> {
		const idleMs = Date.now() - this.lastActivityAt;
		// A paused Parlume hears no speech, so its silence is not the meeting's.
		if (
			!bridge.botId ||
			this.floor.busy ||
			this.controls.paused ||
			idleMs < IDLE_LEAVE_MS ||
			(await this.ctx.storage.get<boolean>(IDLE_REPORTED_KEY))
		) {
			return;
		}
		const reported = await this.postToFabric("/api/internal/parlume/idle", {
			sessionId: bridge.sessionId,
			botId: bridge.botId,
			idleMs,
		});
		log(reported ? "info" : "warn", "idle.reported", {
			sessionId: bridge.sessionId,
			botId: bridge.botId,
			idleMs,
			accepted: Boolean(reported),
		});
		if (reported) {
			await this.ctx.storage.put(IDLE_REPORTED_KEY, true);
		}
	}

	private async verifyStreamWithRetry(
		state: StreamConnection,
		botId: string,
	): Promise<boolean> {
		for (const delay of VERIFY_BACKOFF_MS) {
			const response = await this.requestFabric(
				"/api/internal/parlume/verify-stream",
				{
					sessionId: state.sessionId,
					streamToken: state.token,
					botId,
				},
			);
			if (response?.ok) {
				const streamGeneration = await this.persistVerifiedStream(
					response,
					state,
					botId,
				);
				if (streamGeneration !== null) {
					state.streamGeneration = streamGeneration;
					return true;
				}
			}
			if (response?.status !== 202) {
				return false;
			}
			await new Promise<void>((resolve) => setTimeout(resolve, delay));
		}
		return false;
	}

	private async persistVerifiedStream(
		response: Response,
		state: StreamConnection,
		botId: string,
	): Promise<number | null> {
		const verified = parseParlumeVerifiedStream(
			await response.json().catch(() => null),
			{ sessionId: state.sessionId, botId },
		);
		if (!verified) {
			return null;
		}
		await this.saveBridge(verified.bridge);
		// A provider reconnect may follow a transient WebSocket close. Do not
		// let that old close finalize the session after this newer stream proves
		// it is live.
		await this.ctx.storage.delete(STREAM_CLOSED_KEY);
		await this.noteActivity({ persist: true });
		await this.ctx.storage.delete(IDLE_REPORTED_KEY);
		// Before anything can be said: answers wait for Fabric's checks, and
		// a guest the invitation named is in from the start.
		await this.guests.expectChecks(verified.checksAttendees);
		const guestArrived = await this.guests.invite(
			verified.externalInvitees,
		);
		if (verified.joinNotice) {
			await this.chat.expectJoinNotice();
		}
		// A stream that reconnects before its audio was whole keeps what the
		// earlier one still had to say, and its deadline: the guests notice
		// was lost when a reconnect replaced it.
		const earlier = this.pendingWelcome;
		if (verified.joinNotice || guestArrived || earlier) {
			this.pendingWelcome = {
				sessionId: state.sessionId,
				botId,
				notice: earlier?.notice ?? verified.joinNotice,
				guestArrived: guestArrived || earlier?.guestArrived === true,
				verifiedAt: earlier?.verifiedAt ?? Date.now(),
				readiness: new ParlumeAudioReadiness(),
			};
		}
		// The alarm also gives the welcome by its deadline when no audio
		// arrives at all.
		const hardStopAt = parlumeHardStopMs(verified.bridge);
		if (!Number.isNaN(hardStopAt)) {
			await this.ctx.storage.setAlarm(
				Math.min(
					hardStopAt,
					Date.now() + ACCESS_CHECK_MS,
					this.welcomeDueAt(),
				),
			);
		}
		this.statusTile.changed();
		log("info", "stream.verified", {
			sessionId: state.sessionId,
			botId,
			streamGeneration: verified.streamGeneration,
			hardStopAt: verified.bridge.hardStopAt,
			externalInvitees: verified.externalInvitees,
		});
		return verified.streamGeneration;
	}

	private async saveBridge(bridge: BridgeState): Promise<void> {
		await this.ctx.storage.put<BridgeState>("bridge", bridge);
		this.openUntil = parlumeOpenUntil(bridge);
	}

	/** When a pending welcome is due whatever the audio; never without one. */
	private welcomeDueAt(): number {
		return this.pendingWelcome
			? this.pendingWelcome.verifiedAt + PARLUME_AUDIO_READY_MAX_WAIT_MS
			: Number.POSITIVE_INFINITY;
	}

	/**
	 * The welcome waits until the stream's audio arrives whole, or at most
	 * `PARLUME_AUDIO_READY_MAX_WAIT_MS` after the stream was verified: a
	 * request said in the first seconds after the bot joined went unheard.
	 */
	private noteWelcomeAudio(
		chunk: { chunkMs: number; atMs: number } | null,
	): void {
		const pending = this.pendingWelcome;
		if (!pending) {
			return;
		}
		const whole =
			chunk !== null && pending.readiness.note(chunk.chunkMs, chunk.atMs);
		const waitedMs = Date.now() - pending.verifiedAt;
		if (!whole && waitedMs < PARLUME_AUDIO_READY_MAX_WAIT_MS) {
			return;
		}
		this.pendingWelcome = null;
		log("info", "welcome.audio_ready", {
			sessionId: pending.sessionId,
			botId: pending.botId,
			waitedMs,
			whole,
		});
		void this.welcome(pending.notice, pending.guestArrived);
	}

	/**
	 * The bot is in. The meeting gets the join notice (D4) once per session
	 * and, when a guest is in, the notice that Parlume keeps notes only (D2).
	 */
	private async welcome(
		notice: ParlumeJoinNotice | null,
		guestArrived: boolean,
	): Promise<void> {
		if (notice) {
			await this.chat.giveJoinNotice(notice);
		}
		if (guestArrived) {
			await this.guestArrived(true);
		}
	}

	/**
	 * A guest came in (D2). Parlume stops speaking at once and its realtime
	 * voice ends for the rest of the meeting. A guest the invitation named
	 * gets the notice that Parlume keeps notes only. One who joins is someone
	 * Fabric could not confirm: Fabric says why in the chat and has Parlume
	 * leave, so no notes-only notice comes first. Everything before the first
	 * await happens at once.
	 */
	private async guestArrived(invited: boolean): Promise<void> {
		const stopping = this.floor.stop("guest");
		this.realtime?.stop("guests");
		this.realtime = null;
		this.giveUpRealtime();
		await stopping;
		if (invited) {
			await this.chat.noteGuestArrived();
		}
	}

	private async postToFabric(
		path: string,
		body: object,
	): Promise<Response | null> {
		const response = await this.requestFabric(path, body);
		return response?.ok ? response : null;
	}

	private async requestFabric(
		path: string,
		body: object,
	): Promise<Response | null> {
		if (!this.env.FABRIC_API_URL || !this.env.AGENT_SERVICE_SECRET) {
			return null;
		}
		// A request that never answers would hold what waits on it, such as
		// the realtime voice's Fabric job, for the rest of the meeting.
		const timeout = new AbortController();
		setTimeout(() => timeout.abort(), FABRIC_REQUEST_TIMEOUT_MS);
		try {
			const response = await fetch(`${this.env.FABRIC_API_URL}${path}`, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					"X-Agent-Service-Token": this.env.AGENT_SERVICE_SECRET,
				},
				body: JSON.stringify(body),
				signal: timeout.signal,
			});
			return response;
		} catch {
			return null;
		}
	}

	private async persistFinalSegment(segment: PendingSegment): Promise<void> {
		if (
			await this.postToFabric("/api/internal/parlume/segments", segment)
		) {
			return;
		}
		const pending =
			(await this.ctx.storage.get<PendingSegment[]>(
				PENDING_SEGMENTS_KEY,
			)) ?? [];
		if (pending.length >= MAX_PENDING_SEGMENTS) {
			await this.ctx.storage.put<StreamError>(STREAM_ERROR_KEY, {
				sessionId: segment.sessionId,
				botId: segment.botId,
			});
			const bridge = await this.ctx.storage.get<BridgeState>("bridge");
			await this.schedulePendingRetry(parlumeHardStopMs(bridge));
			return;
		}
		pending.push(segment);
		await this.ctx.storage.put(PENDING_SEGMENTS_KEY, pending);
		const bridge = await this.ctx.storage.get<BridgeState>("bridge");
		await this.schedulePendingRetry(parlumeHardStopMs(bridge));
	}

	private queueFinalSegment(segment: PendingSegment): Promise<void> {
		const persist = this.finalSegmentChain.then(() =>
			this.persistFinalSegment(segment),
		);
		this.finalSegmentChain = persist.catch(() => undefined);
		return persist;
	}

	private async flushPendingSegments(): Promise<boolean> {
		const pending =
			(await this.ctx.storage.get<PendingSegment[]>(
				PENDING_SEGMENTS_KEY,
			)) ?? [];
		if (pending.length === 0) {
			return true;
		}
		let index = 0;
		const limit = Math.min(pending.length, MAX_SEGMENTS_PER_FLUSH);
		for (; index < limit; index++) {
			const segment = pending[index];
			if (
				!segment ||
				!(await this.postToFabric(
					"/api/internal/parlume/segments",
					segment,
				))
			) {
				break;
			}
		}
		if (index === pending.length) {
			await this.ctx.storage.delete(PENDING_SEGMENTS_KEY);
			return true;
		}
		await this.ctx.storage.put(PENDING_SEGMENTS_KEY, pending.slice(index));
		const bridge = await this.ctx.storage.get<BridgeState>("bridge");
		await this.schedulePendingRetry(parlumeHardStopMs(bridge));
		return false;
	}

	private async reportClosedStreamIfDrained(): Promise<void> {
		const pending =
			(await this.ctx.storage.get<PendingSegment[]>(
				PENDING_SEGMENTS_KEY,
			)) ?? [];
		const closed =
			await this.ctx.storage.get<StreamClosed>(STREAM_CLOSED_KEY);
		if (pending.length > 0 || !closed) {
			return;
		}
		if (
			await this.postToFabric(
				"/api/internal/parlume/stream-closed",
				closed,
			)
		) {
			await this.ctx.storage.delete(STREAM_CLOSED_KEY);
		}
	}

	/**
	 * "Parlume, stop. What is next?": the stop has ended the answer, and what
	 * follows it is a request of its own, in either voice.
	 */
	private async askAfterStop(
		segment: PendingSegment,
		speakerKey: string,
	): Promise<void> {
		const text = parlumeRequestAfterStop(segment.text);
		if (!text) {
			return;
		}
		const realtime = this.answeringRealtime();
		if (realtime) {
			realtime.noteLine(segment.speakerName, segment.text);
			void realtime.respondToRequest(
				segment.speakerName,
				speakerKey,
				text,
			);
			return;
		}
		await this.beginWakeTurn(segment, speakerKey, {
			text,
			armed: false,
		});
	}

	private async beginWakeTurn(
		segment: PendingSegment,
		speakerKey: string,
		resolved?: { text: string; armed: boolean },
	): Promise<void> {
		const wake = resolved ?? (await this.resolveWakeTurn(segment));
		if (!wake) {
			return;
		}
		// A guest's wake phrase starts no turn (D2).
		if (this.guests.isGuest(segment.speakerId)) {
			log("info", "wake.from_guest", {
				sessionId: segment.sessionId,
				botId: segment.botId,
			});
			return;
		}
		const reference = parseParlumeSpokenReference(wake.text);
		const action = reference
			? await this.postReferenceAction(segment, reference)
			: null;
		const asker = { name: segment.speakerName, id: segment.speakerId };
		// A post read aloud waits for what Parlume is saying, and the turn it
		// is answering carries on.
		if (action?.kind === "speak") {
			void this.floor.speakLocally(action.text, asker);
			return;
		}
		// A post this meeting cannot act on is answered as the typed command
		// is, and is never asked of Fabric as a request of its own.
		if (reference && !action) {
			void this.floor.speakLocally(
				parlumePostNotAvailableLine(reference.tag),
				asker,
			);
			return;
		}
		// Another speaker's request still being heard out is handed over
		// first. Parlume is answering: the request waits for that answer,
		// once its speaker has finished it.
		this.turnEndpoint.complete();
		// In the last two minutes before the cap, the request takes no new
		// voice generation: it starts from the queue, answered in the chat.
		const queued = this.floor.requests.mustWait || this.capClosing();
		const turnText = action?.kind === "ask" ? action.text : wake.text;
		const generation = queued
			? this.floor.generation
			: await this.floor.beginReply(true, segment.speakerName);
		this.wokeAt = Date.now();
		log("info", "wake.detected", {
			sessionId: segment.sessionId,
			botId: segment.botId,
			speakerId: segment.speakerId,
			voiceGeneration: generation,
			requestChars: turnText.length,
			queued,
		});
		this.turnEndpoint.begin(
			!segment.speakerId &&
				!segment.speakerName &&
				isIncompleteParlumeDictation(turnText)
				? null
				: speakerKey,
			{
				voiceGeneration: generation,
				sessionId: segment.sessionId,
				botId: segment.botId,
				text: turnText,
				speakerName: segment.speakerName,
				speakerId: segment.speakerId,
				utteranceStartMs: segment.utteranceStartMs,
				utteranceEndMs: segment.utteranceEndMs,
				replyChannel: "VOICE",
				queued: queued || undefined,
			},
			// A request that came with its wake phrase ended on Flux's own
			// end-of-turn. One that followed a bare "Hey Fabric" keeps the
			// endpoint's default window.
			wake.armed ? undefined : PARLUME_COMPLETE_REQUEST_QUIET_MS,
		);
	}

	/**
	 * Flux guesses early that a turn has ended, and takes the guess back if the
	 * speaker goes on. A complete request to the classic voice starts on the
	 * guess, which saves the rest of Flux's end-of-turn wait; a guess taken
	 * back stops it, until its answer is heard: from its first audio on, only
	 * a stop ends it. Chat post commands and dictation wait for the final
	 * transcript, and so does any request while Parlume is already answering,
	 * others wait, or the cap is less than two minutes away.
	 */
	private async onTentativeEnd(
		state: StreamConnection,
		segment: PendingSegment,
		tentative: "eager" | "resumed",
		speakerKey: string,
	): Promise<void> {
		if (tentative === "resumed") {
			const eager = this.eagerTurn;
			if (
				!eager ||
				eager.generation !== this.floor.generation ||
				this.floor.hasSpoken(eager.generation)
			) {
				return;
			}
			this.eagerTurn = null;
			log("info", "turn.eager_resumed", {
				sessionId: segment.sessionId,
				botId: segment.botId,
				voiceGeneration: eager.generation,
			});
			await this.floor.interrupt(state);
			return;
		}
		const request = parseParlumeWake(segment.text);
		if (
			!request ||
			classifyParlumeStop(segment.text, true) !== "none" ||
			isSpokenParlumePause(segment.text) ||
			segment.speakerName?.toLowerCase().includes("parlume") ||
			this.floor.requests.mustWait ||
			this.capClosing() ||
			parseParlumeSpokenReference(request) ||
			isIncompleteParlumeDictation(request)
		) {
			return;
		}
		await this.beginWakeTurn(segment, speakerKey);
		this.eagerTurn = { request, generation: this.floor.generation };
		log("info", "turn.eager_started", {
			sessionId: segment.sessionId,
			botId: segment.botId,
			voiceGeneration: this.floor.generation,
		});
	}

	/**
	 * Whether the final transcript asks what the early start already asked.
	 * One that asks anything else stops the early answer and goes on as a
	 * transcript of its own, unless that answer is already being heard: then
	 * the answer stands, and the final is not asked again.
	 */
	private async settleEagerTurn(
		state: StreamConnection,
		segment: PendingSegment,
	): Promise<boolean> {
		const eager = this.eagerTurn;
		this.eagerTurn = null;
		if (!eager || eager.generation !== this.floor.generation) {
			return false;
		}
		const request = parseParlumeWake(segment.text);
		if (
			(request !== null &&
				isSameParlumeRequest(request, eager.request)) ||
			this.floor.hasSpoken(eager.generation)
		) {
			return true;
		}
		log("info", "turn.eager_discarded", {
			sessionId: segment.sessionId,
			botId: segment.botId,
			voiceGeneration: eager.generation,
		});
		await this.floor.interrupt(state);
		return false;
	}

	/**
	 * "Parlume, go P3" acts on a chat post the way the typed command does, and
	 * is answered aloud, in either voice.
	 */
	private async postReferenceAction(
		segment: PendingSegment,
		reference: ParlumeSpokenReference,
	): Promise<ParlumePostAction | null> {
		const action = await this.chat.spokenReference(reference);
		if (action) {
			log("info", "wake.post_reference", {
				sessionId: segment.sessionId,
				botId: segment.botId,
				command: reference.kind,
				tag: reference.tag,
				action: action.kind,
			});
		}
		return action;
	}

	/**
	 * A final segment that looks addressed to Parlume but did not wake it, as
	 * a wake phrase clipped or lost under overlapping speech leaves it. Only
	 * its length is logged, never its words; one that answers a bare "Hey
	 * Fabric" (`wakeArmMatches`) is a request, not a near miss.
	 */
	private async logWakeNearMiss(
		segment: PendingSegment,
		speakerKey: string,
	): Promise<void> {
		const reason = findParlumeWakeNearMiss(segment.text);
		if (!reason) {
			return;
		}
		const armed = await this.ctx.storage.get<WakeArm>(WAKE_ARM_KEY);
		if (armed && wakeArmMatches(armed, speakerKey)) {
			return;
		}
		log("info", "wake.near_miss", {
			sessionId: segment.sessionId,
			botId: segment.botId,
			speakerId: segment.speakerId,
			reason,
			chars: segment.text.length,
		});
	}

	private async resolveWakeTurn(input: {
		text: string;
		speakerName: string | null;
		speakerId: string | null;
	}): Promise<{ text: string; armed: boolean } | null> {
		if (input.speakerName?.toLowerCase().includes("parlume")) {
			return null;
		}
		const speakerKey = parlumeSpeakerKey(
			input.speakerId,
			input.speakerName,
		);
		const afterWake = parseParlumeWake(input.text);
		if (afterWake !== null) {
			if (afterWake) {
				return { text: afterWake, armed: false };
			}
			await this.ctx.storage.put<WakeArm>(WAKE_ARM_KEY, {
				speakerKey,
				expiresAt: Date.now() + WAKE_ARM_MS,
			});
			return null;
		}
		const armed = await this.ctx.storage.get<WakeArm>(WAKE_ARM_KEY);
		if (!armed) {
			return null;
		}
		if (armed.expiresAt < Date.now()) {
			await this.ctx.storage.delete(WAKE_ARM_KEY);
			return null;
		}
		if (!wakeArmMatches(armed, speakerKey)) {
			return null;
		}
		await this.ctx.storage.delete(WAKE_ARM_KEY);
		return { text: input.text, armed: true };
	}

	private async dispatchTurn(turn: PendingTurn): Promise<void> {
		const endpointedAt = Date.now();
		if (turn.queued) {
			await this.floor.requests.turn(turn, {
				name: turn.speakerName,
				id: turn.speakerId,
			});
			return;
		}
		// Not held for the transcript segments still being posted: the turn
		// carries its own request, and the worker reads the meeting's segments
		// only after its workflow has started, by when they have usually landed.
		if (turn.voiceGeneration !== this.floor.generation) {
			log("info", "turn.superseded", {
				sessionId: turn.sessionId,
				botId: turn.botId,
				voiceGeneration: turn.voiceGeneration,
			});
			return;
		}
		const posted =
			(await this.floor.flushPendingInterrupt()) &&
			turn.voiceGeneration === this.floor.generation
				? await this.postTurn(turn, endpointedAt)
				: null;
		if (posted) {
			if (posted.accepted) {
				this.statusTile.changed();
				log("info", "turn.dispatched", {
					sessionId: turn.sessionId,
					botId: turn.botId,
					voiceGeneration: turn.voiceGeneration,
					requestChars: turn.text.length,
					// Wake phrase to the end of the request, then to Fabric's accept.
					endpointMs: endpointedAt - this.wokeAt,
					handoffMs: posted.handoffMs,
					// Fabric's own steps, from when its handler started.
					fabricTiming: posted.timing,
				});
			}
			return;
		}
		log("warn", "turn.deferred", {
			sessionId: turn.sessionId,
			botId: turn.botId,
			voiceGeneration: turn.voiceGeneration,
		});
		const pending =
			(await this.ctx.storage.get<PendingTurn[]>(PENDING_TURNS_KEY)) ??
			[];
		if (pending.length >= MAX_PENDING_SEGMENTS) {
			await this.ctx.storage.put<StreamError>(STREAM_ERROR_KEY, {
				sessionId: turn.sessionId,
				botId: turn.botId,
			});
			const bridge = await this.ctx.storage.get<BridgeState>("bridge");
			await this.schedulePendingRetry(parlumeHardStopMs(bridge));
			return;
		}
		pending.push(turn);
		await this.ctx.storage.put(PENDING_TURNS_KEY, pending);
		await this.ctx.storage.setAlarm(Date.now() + TURN_RETRY_MS);
	}

	/**
	 * Hands a turn to Fabric: null when Fabric could not be reached. Fabric
	 * answers `accepted: false`, not an error, for a session that is no longer
	 * live, a superseded generation or a duplicate request. That request is not
	 * answered, so it is logged as not accepted, never as dispatched.
	 */
	private async postTurn(
		turn: PendingTurn,
		startedAt: number,
	): Promise<PostedTurn | null> {
		const response = await this.postToFabric(
			"/api/internal/parlume/turns",
			// Fabric reads the turn with the asker's access: who asked, as the
			// confirmed participant they are, at the moment it is handed over.
			{
				...turn,
				attendees: this.guests.attendees(),
				requester: this.guests.userFor(turn.speakerId),
			},
		);
		if (!response) {
			return null;
		}
		const handoffMs = Date.now() - startedAt;
		const body: unknown = await response.json().catch(() => null);
		const accepted = !(isRecord(body) && body.accepted === false);
		if (!accepted) {
			log("warn", "turn.not_accepted", {
				sessionId: turn.sessionId,
				botId: turn.botId,
				voiceGeneration: turn.voiceGeneration,
				requestChars: turn.text.length,
				handoffMs,
			});
		}
		return {
			accepted,
			handoffMs,
			timing:
				isRecord(body) && isRecord(body.timing) ? body.timing : null,
		};
	}

	private async flushPendingTurns(): Promise<boolean> {
		if (!(await this.floor.flushPendingInterrupt())) {
			return false;
		}
		const pending =
			(await this.ctx.storage.get<PendingTurn[]>(PENDING_TURNS_KEY)) ??
			[];
		if (pending.length === 0) {
			return true;
		}
		let index = 0;
		const limit = Math.min(pending.length, MAX_SEGMENTS_PER_FLUSH);
		for (; index < limit; index++) {
			const turn = pending[index];
			if (turn && turn.voiceGeneration !== this.floor.generation) {
				continue;
			}
			if (!turn || !(await this.postTurn(turn, Date.now()))) {
				break;
			}
		}
		if (index === pending.length) {
			await this.ctx.storage.delete(PENDING_TURNS_KEY);
			return true;
		}
		await this.ctx.storage.put(PENDING_TURNS_KEY, pending.slice(index));
		await this.ctx.storage.setAlarm(Date.now() + TURN_RETRY_MS);
		return false;
	}

	private async schedulePendingRetry(hardStopAt: number): Promise<void> {
		await this.ctx.storage.setAlarm(
			hardStopAt > Date.now()
				? Math.min(hardStopAt, Date.now() + WATCHDOG_RETRY_MS)
				: Date.now() + WATCHDOG_RETRY_MS,
		);
	}

	private async reportStreamFailure(): Promise<boolean> {
		const failure =
			await this.ctx.storage.get<StreamError>(STREAM_ERROR_KEY);
		if (!failure) {
			return false;
		}
		if (
			await this.postToFabric(
				"/api/internal/parlume/stream-error",
				failure,
			)
		) {
			await this.ctx.storage.delete(STREAM_ERROR_KEY);
			const bridge = await this.ctx.storage.get<BridgeState>("bridge");
			const hardStopAt = parlumeHardStopMs(bridge);
			if (Number.isFinite(hardStopAt) && hardStopAt > Date.now()) {
				await this.ctx.storage.setAlarm(hardStopAt);
			}
			return true;
		}
		const bridge = await this.ctx.storage.get<BridgeState>("bridge");
		await this.schedulePendingRetry(parlumeHardStopMs(bridge));
		return true;
	}

	private async verifyInviterAccess(
		bridge: BridgeState,
	): Promise<"active" | "retry" | "stopped"> {
		if (!bridge.botId) {
			return "active";
		}
		// The open-socket count lets Fabric finalize a session whose bot is
		// already gone when no stream is left to close (a worker restart drops
		// sockets without an onClose), instead of waiting for the hard stop.
		const response = await this.requestFabric(
			"/api/internal/parlume/verify-access",
			{
				sessionId: bridge.sessionId,
				botId: bridge.botId,
				openConnections: this.connections.size,
			},
		);
		if (!response?.ok) {
			await this.schedulePendingRetry(parlumeHardStopMs(bridge));
			return "retry";
		}
		try {
			const payload: unknown = await response.json();
			return isRecord(payload) && payload.captureStopped === true
				? "stopped"
				: "active";
		} catch {
			await this.schedulePendingRetry(parlumeHardStopMs(bridge));
			return "retry";
		}
	}
}
