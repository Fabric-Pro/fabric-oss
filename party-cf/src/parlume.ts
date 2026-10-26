import { type Connection, type ConnectionContext, Server } from "partyserver";
import type { Env } from "./env";
import type { ParlumeAuraBinding } from "./parlume-aura";
import { classifyParlumeBargeIn } from "./parlume-barge-in";
import type { ParlumeChatMessage } from "./parlume-chat";
import {
	type ParlumeChatBot,
	ParlumeChatChannel,
	type ParlumeChatTurn,
	type ParlumePostAction,
} from "./parlume-chat-channel";
import type { ParlumeReplyChannel } from "./parlume-chat-commands";
import {
	PARLUME_SPEECH_SAMPLE_RATE,
	ParlumeAudioOutlet,
	parlumeBotOutputMessage,
} from "./parlume-pcm";
import { createParlumeRealtimeEngine } from "./parlume-realtime-bridge";
import {
	type ParlumeRealtimeContext,
	type ParlumeRealtimeEngine,
	parseParlumeFabricResult,
} from "./parlume-realtime-engine";
import { ParlumeSpeakerTimeline } from "./parlume-speakers";
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
} from "./parlume-transcriber";
import {
	isIncompleteParlumeDictation,
	PARLUME_COMPLETE_REQUEST_QUIET_MS,
	ParlumeTurnEndpoint,
} from "./parlume-turn-endpoint";
import { ParlumeVoiceFloor, UNKNOWN_SPEAKER } from "./parlume-voice-floor";
import {
	isSameParlumeRequest,
	mayNameParlumePost,
	parseParlumeSpokenReference,
	parseParlumeWake,
} from "./parlume-wake";

const WATCHDOG_RETRY_MS = 5 * 60 * 1000;
const ACCESS_CHECK_MS = 60 * 1000;
const TURN_RETRY_MS = 2_000;
const VERIFY_BACKOFF_MS = [100, 250, 500, 1_000, 2_000, 4_000];
const PENDING_SEGMENTS_KEY = "pendingSegments";
const STREAM_CLOSED_KEY = "streamClosed";
const STREAM_ERROR_KEY = "streamError";
const WAKE_ARM_KEY = "wakeArm";
const PENDING_TURNS_KEY = "pendingTurns";
// The Durable Object is restarted now and then by Cloudflare (a runtime
// update, a host move) even mid-meeting; the realtime voice resumes from this.
const REALTIME_CONTEXT_KEY = "realtimeContext";
const MAX_PENDING_SEGMENTS = 1_000;
const MAX_SEGMENTS_PER_FLUSH = 25;
// Nobody has spoken for this long and Parlume is silent: treat the meeting
// as over. The provider's own silence timeout cannot go below five minutes.
const IDLE_LEAVE_MS = 3 * 60 * 1000;
const LAST_ACTIVITY_KEY = "lastActivityAt";
const IDLE_REPORTED_KEY = "idleReported";
// Flux's end-of-turn confidence for its early guess; its final needs 0.7.
const PARLUME_EAGER_EOT_THRESHOLD = "0.5";

interface BridgeState {
	sessionId: string;
	botId: string | null;
	hardStopAt: string | null;
	suggestionsEnabled?: boolean;
}

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
}

interface WakeArm {
	speakerKey: string;
	expiresAt: number;
}

interface StreamClosed {
	sessionId: string;
	botId: string;
	streamGeneration: number;
}

interface StreamError {
	sessionId: string;
	botId: string;
}

function parlumeSpeakerKey(
	speakerId: string | null,
	speakerName: string | null,
): string {
	return speakerId ?? speakerName?.toLowerCase() ?? UNKNOWN_SPEAKER;
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
	private chat = new ParlumeChatChannel({
		storage: this.ctx.storage,
		postToFabric: (path, body) => this.postToFabric(path, body),
		bot: () => this.chatBot(),
		isParlumeSender: (name) => this.isBotSpeaker(name ?? undefined),
		isBusy: () => this.floor.isAnswering(),
		speak: (text) => this.speakLocally(text),
		interrupt: async () => {
			const bot = await this.chatBot();
			if (bot && this.floor.isAnswering()) {
				await this.floor.interrupt(bot);
			}
		},
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
	private floor = new ParlumeVoiceFloor<Connection>({
		storage: this.ctx.storage,
		sessionId: () => this.name,
		// Workers AI's binding types cannot name Aura's raw-response overload.
		aura: this.env.AI as unknown as ParlumeAuraBinding,
		chat: this.chat,
		postToFabric: (path, body) => this.postToFabric(path, body),
		liveConnection: () => this.liveStream(),
		isConnected: (connection) => this.connections.has(connection),
		meetingOpen: async () => {
			const bridge = await this.ctx.storage.get<BridgeState>("bridge");
			return Boolean(
				bridge &&
					!(
						bridge.hardStopAt &&
						new Date(bridge.hardStopAt).getTime() <= Date.now()
					),
			);
		},
		cancelEndpoint: () => this.turnEndpoint.cancel(),
		realtime: () => this.realtimeVoice(),
		log,
	});
	// Set while the realtime engine is starting or speaking; null when the
	// meeting runs on the classic engine.
	private realtime: ParlumeRealtimeEngine | null = null;
	/** Where on the audio clock the latest final transcript ended. */
	private finalHeardUntil = 0;
	// Realtime could not be started or kept up: classic for the rest of the
	// meeting, stream reconnects included.
	private realtimeGaveUp = false;

	async onStart() {
		await this.floor.load();
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
					const verified = await this.verifyStreamWithRetry(
						state,
						botId,
					);
					if (verified) {
						this.dropSupersededStreams(state);
						void this.startRealtime(state.sessionId, botId);
					}
					return verified;
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
		// Each reply message names its own rate, so speech stays at the rate it
		// was synthesized whatever rate the meeting audio arrives at.
		this.floor.setOutlet(
			conn,
			new ParlumeAudioOutlet({
				sampleRate: PARLUME_SPEECH_SAMPLE_RATE,
				send: (frame) =>
					conn.send(
						parlumeBotOutputMessage(
							frame,
							PARLUME_SPEECH_SAMPLE_RATE,
						),
					),
			}),
		);
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
		if (!state.botId || !audio) {
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
		const speakerKey = parlumeSpeakerKey(speakerId, speakerName);
		if (!fromBot) {
			await this.noteActivity({ persist: transcript.isFinal });
			if (transcript.isFinal && this.chat.noteSpeechSegment()) {
				await this.wakeForSuggestionPass();
			}
		}
		const realtime = this.realtimeVoice();
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
		if (transcript.tentative) {
			if (!realtime && !fromBot) {
				await this.onTentativeEnd(
					state,
					segment,
					transcript.tentative,
					speakerKey,
				);
			}
			return;
		}
		if (!transcript.isFinal) {
			await this.floor.onPartial(state, {
				fromBot,
				text: transcript.text,
				held: () => this.turnEndpoint.hold(speakerKey),
			});
			const partialWake =
				realtime && !fromBot ? parseParlumeWake(transcript.text) : null;
			if (
				realtime &&
				!fromBot &&
				classifyParlumeBargeIn(transcript.text) === "cancel"
			) {
				realtime.disarm();
			} else if (
				realtime &&
				partialWake !== null &&
				!mayNameParlumePost(partialWake) &&
				// Transcripts are handled concurrently: a partial of an
				// utterance whose final was already answered must not arm
				// Parlume again.
				transcript.endMs > this.finalHeardUntil
			) {
				realtime.arm({
					requester: speakerName,
					speakerKey,
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
		const bargeIn = eagerKept
			? "ignore"
			: await this.floor.onFinal(state, {
					fromBot,
					text: segment.text,
					speakerId,
					speakerKey,
				});
		if (eagerKept) {
			log("info", "turn.eager_kept", {
				sessionId: state.sessionId,
				botId: state.botId,
				speakerId,
			});
		} else if (bargeIn === "cancel") {
			// A cancel phrase is never a request of its own, even one that
			// opened with Parlume's name and armed the realtime voice.
			realtime?.disarm();
		} else if (!fromBot) {
			if (realtime) {
				// The realtime voice heard the request itself; Flux only says
				// that it was addressed to Parlume, and that it has ended.
				realtime.noteLine(speakerName, segment.text);
				const wake = await this.resolveWakeTurn(segment);
				const action = wake
					? await this.postReferenceAction(segment, wake.text)
					: null;
				if (action?.kind === "speak") {
					void realtime.say(action.text);
				} else if (action?.kind === "ask") {
					void realtime.respondToRequest(
						speakerName,
						speakerKey,
						action.text,
					);
				} else if (
					wake !== null ||
					parseParlumeWake(segment.text) !== null
				) {
					realtime.arm({
						requester: speakerName,
						speakerKey,
						endOfTurn: true,
					});
				}
			} else if (
				!this.turnEndpoint.append(
					speakerKey,
					segment.text,
					segment.utteranceEndMs,
				)
			) {
				await this.beginWakeTurn(state, segment, speakerKey);
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
		this.floor.dropOutlet(conn);
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
			return this.chat.send(await request.json().catch(() => null));
		}
		if (action === "chat-message") {
			return this.chat.receive(await request.json().catch(() => null));
		}
		if (action === "speakers") {
			return this.updateSpeakers(request);
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
			// `muted`: the turn was spoken over and now answers in the chat.
			const state =
				isRecord(body) && typeof body.voiceGeneration === "number"
					? this.floor.generationState(body.voiceGeneration)
					: { current: false, muted: false };
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
		await this.ctx.storage.put<BridgeState>("bridge", {
			sessionId: this.name,
			botId: null,
			hardStopAt: hardStopAt.toISOString(),
		});
		await this.ctx.storage.setAlarm(hardStopAt.getTime());
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

	private isBotSpeaker(name: string | undefined): boolean {
		return Boolean(name && /^Fabric Parlume\b/i.test(name));
	}

	// The bridge knows the session's provider bot; Fabric holds the provider key.
	private async chatBot(): Promise<ParlumeChatBot | null> {
		const bridge = await this.ctx.storage.get<BridgeState>("bridge");
		return bridge?.botId
			? { sessionId: bridge.sessionId, botId: bridge.botId }
			: null;
	}

	private liveStream(): {
		connection: Connection;
		stream: StreamConnection;
	} | null {
		const live = [...this.connections].find(
			([, state]) => state.verified && state.botId,
		);
		return live ? { connection: live[0], stream: live[1] } : null;
	}

	// Chat lines sit in the transcript at the time they were sent, on the same
	// clock as the speech around them.
	private persistChatSegment(
		bot: ParlumeChatBot,
		message: ParlumeChatMessage,
	): void {
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

	private speakLocally(text: string): Promise<boolean> {
		return this.realtimeVoice()?.say(text) ?? this.floor.speakLocally(text);
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
	 * Chooses the meeting's voice once its stream is verified: realtime when
	 * Fabric can mint a session for the organization's OpenAI key, classic
	 * otherwise, and classic for good once realtime cannot be started or kept
	 * up.
	 */
	private async startRealtime(sessionId: string, botId: string) {
		if (this.realtime || this.realtimeGaveUp) {
			return;
		}
		const engine = createParlumeRealtimeEngine({
			sessionId,
			botId,
			postToFabric: (path, body) => this.postToFabric(path, body),
			segmentsSent: () => this.finalSegmentChain,
			outlet: () => {
				const live = this.liveStream();
				return (live && this.floor.outlet(live.connection)) ?? null;
			},
			generation: () => this.floor.generation,
			chat: this.chat,
			saveContext: (context) =>
				void this.ctx.storage.put(REALTIME_CONTEXT_KEY, context),
			fallBack: (stopped, reason) => {
				if (this.realtime === stopped) {
					this.realtime = null;
					this.realtimeGaveUp = true;
					log("warn", "engine", {
						sessionId,
						botId,
						engine: "classic",
						reason,
					});
				}
			},
			log,
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
			this.realtimeGaveUp = true;
		}
		log("info", "engine", {
			sessionId,
			botId,
			engine: started.ok ? "realtime" : "classic",
			reason: started.ok ? null : started.reason,
		});
	}

	/**
	 * A request typed in the chat replaces whatever Parlume was answering, as
	 * a new wake phrase does. Its reply goes to the chat unless it asked to be
	 * said aloud; only a spoken reply holds the voice open. With the realtime
	 * engine, a spoken reply is the realtime voice's own, and nothing it is
	 * doing is replaced.
	 */
	private async dispatchChatTurn(request: ParlumeChatTurn): Promise<void> {
		const bot = await this.chatBot();
		if (!bot) {
			return;
		}
		const realtime = this.realtimeVoice();
		if (realtime && request.replyChannel === "VOICE") {
			log("info", "chat.turn", {
				...bot,
				replyChannel: request.replyChannel,
				engine: "realtime",
				requestChars: request.text.length,
			});
			await realtime.respondToChat(request.speakerName, request.text);
			return;
		}
		if (this.floor.isClassicAnswering()) {
			await this.floor.interrupt(bot);
		}
		const voice = request.replyChannel === "VOICE";
		const generation = await this.floor.beginReply(voice);
		if (!voice) {
			this.chat.beginChatTurn(generation);
		}
		this.wokeAt = Date.now();
		log("info", "chat.turn", {
			...bot,
			voiceGeneration: generation,
			replyChannel: request.replyChannel,
			requestChars: request.text.length,
		});
		await this.dispatchTurn({
			...bot,
			voiceGeneration: generation,
			text: request.text,
			speakerName: request.speakerName,
			speakerId: request.speakerId,
			utteranceStartMs: null,
			utteranceEndMs: null,
			replyChannel: request.replyChannel,
			chatMessageId: request.chatMessageId,
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
		if (!(await this.floor.flushPendingInterrupt())) {
			return;
		}
		if (await this.reportStreamFailure()) {
			return;
		}
		const access = await this.verifyInviterAccess(bridge);
		if (access !== "active") {
			const hardStopAt = new Date(bridge.hardStopAt ?? 0).getTime();
			if (access === "stopped") {
				// Capture is over on Fabric's side; close now so the stream-closed
				// report and finalization do not wait for the provider.
				const closed = await this.closeStream("capture stopped");
				log("info", "access.stopped", {
					sessionId: bridge.sessionId,
					botId: bridge.botId,
					closed,
				});
				// A stream-closed report the close could not deliver is retried
				// on the watchdog cadence. Once it is through, Fabric finalizes
				// on the terminal callback; the hard-stop watchdog is left for a
				// callback that never comes, and to clear this bridge's state.
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
					await this.ctx.storage.setAlarm(hardStopAt);
				}
			}
			return;
		}
		await this.reportIdleMeeting(bridge);
		await this.chat.checkDeliveries();
		const suggestions = this.suggestionsEnabled(bridge);
		await this.chat.runSuggestionPass({ enabled: suggestions });
		const [flushed, turnsFlushed] = await Promise.all([
			this.flushPendingSegments(),
			this.flushPendingTurns(),
		]);
		if (flushed) {
			await this.reportClosedStreamIfDrained();
		}
		const hardStopAt = new Date(bridge.hardStopAt ?? 0).getTime();
		if (Number.isFinite(hardStopAt) && Date.now() < hardStopAt) {
			const retryDelay = !flushed
				? WATCHDOG_RETRY_MS
				: !turnsFlushed
					? TURN_RETRY_MS
					: ACCESS_CHECK_MS;
			const chatWakeAt = await this.chat.nextWakeAt({ suggestions });
			await this.ctx.storage.setAlarm(
				Math.min(
					hardStopAt,
					Date.now() + retryDelay,
					chatWakeAt ?? Number.POSITIVE_INFINITY,
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
		if (!response || !flushed || !turnsFlushed) {
			await this.ctx.storage.setAlarm(Date.now() + WATCHDOG_RETRY_MS);
			return;
		}
		await this.ctx.storage.delete("bridge");
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
			this.chat.nextWakeAt({ suggestions: true }),
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
		if (
			!bridge.botId ||
			this.floor.busy ||
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
		let data: unknown;
		try {
			data = await response.json();
		} catch {
			return null;
		}
		if (
			!isRecord(data) ||
			data.valid !== true ||
			typeof data.hardStopAt !== "string" ||
			typeof data.streamGeneration !== "number" ||
			!Number.isSafeInteger(data.streamGeneration) ||
			data.streamGeneration < 1
		) {
			return null;
		}
		await this.ctx.storage.put<BridgeState>("bridge", {
			sessionId: state.sessionId,
			botId,
			hardStopAt: data.hardStopAt,
			suggestionsEnabled: data.suggestionsEnabled === true,
		});
		// A provider reconnect may follow a transient WebSocket close. Do not
		// let that old close finalize the session after this newer stream proves
		// it is live.
		await this.ctx.storage.delete(STREAM_CLOSED_KEY);
		const hardStopAt = new Date(data.hardStopAt);
		if (!Number.isNaN(hardStopAt.getTime())) {
			await this.ctx.storage.setAlarm(
				Math.min(hardStopAt.getTime(), Date.now() + ACCESS_CHECK_MS),
			);
		}
		await this.noteActivity({ persist: true });
		await this.ctx.storage.delete(IDLE_REPORTED_KEY);
		log("info", "stream.verified", {
			sessionId: state.sessionId,
			botId,
			streamGeneration: data.streamGeneration,
			hardStopAt: data.hardStopAt,
		});
		return data.streamGeneration;
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
		try {
			const response = await fetch(`${this.env.FABRIC_API_URL}${path}`, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					"X-Agent-Service-Token": this.env.AGENT_SERVICE_SECRET,
				},
				body: JSON.stringify(body),
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
			await this.schedulePendingRetry(
				bridge?.hardStopAt ? new Date(bridge.hardStopAt).getTime() : 0,
			);
			return;
		}
		pending.push(segment);
		await this.ctx.storage.put(PENDING_SEGMENTS_KEY, pending);
		const bridge = await this.ctx.storage.get<BridgeState>("bridge");
		const hardStopAt = bridge?.hardStopAt
			? new Date(bridge.hardStopAt).getTime()
			: 0;
		await this.schedulePendingRetry(hardStopAt);
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
		await this.schedulePendingRetry(
			bridge?.hardStopAt ? new Date(bridge.hardStopAt).getTime() : 0,
		);
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

	private async beginWakeTurn(
		state: StreamConnection,
		segment: PendingSegment,
		speakerKey: string,
	): Promise<void> {
		const wake = await this.resolveWakeTurn(segment);
		if (!wake) {
			return;
		}
		const action = await this.postReferenceAction(segment, wake.text);
		if (this.floor.isAnswering()) {
			await this.floor.interrupt(state);
		}
		if (action?.kind === "speak") {
			void this.speakLocally(action.text);
			return;
		}
		const turnText = action?.kind === "ask" ? action.text : wake.text;
		const generation = await this.floor.beginReply(true, speakerKey);
		this.wokeAt = Date.now();
		log("info", "wake.detected", {
			sessionId: segment.sessionId,
			botId: segment.botId,
			speakerId: segment.speakerId,
			voiceGeneration: generation,
			requestChars: turnText.length,
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
	 * back stops it. Chat post commands and dictation wait for the final
	 * transcript, and so does any request while Parlume is already answering.
	 */
	private async onTentativeEnd(
		state: StreamConnection,
		segment: PendingSegment,
		tentative: "eager" | "resumed",
		speakerKey: string,
	): Promise<void> {
		if (tentative === "resumed") {
			const eager = this.eagerTurn;
			this.eagerTurn = null;
			if (eager && eager.generation === this.floor.generation) {
				log("info", "turn.eager_resumed", {
					sessionId: segment.sessionId,
					botId: segment.botId,
					voiceGeneration: eager.generation,
				});
				await this.floor.interrupt(state);
			}
			return;
		}
		const request = parseParlumeWake(segment.text);
		if (
			!request ||
			classifyParlumeBargeIn(segment.text) === "cancel" ||
			segment.speakerName?.toLowerCase().includes("parlume") ||
			this.floor.isAnswering() ||
			parseParlumeSpokenReference(request) ||
			isIncompleteParlumeDictation(request)
		) {
			return;
		}
		await this.beginWakeTurn(state, segment, speakerKey);
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
	 * transcript of its own.
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
		if (request !== null && isSameParlumeRequest(request, eager.request)) {
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
		request: string,
	): Promise<ParlumePostAction | null> {
		const reference = parseParlumeSpokenReference(request);
		const action = reference
			? await this.chat.spokenReference(reference)
			: null;
		if (reference && action) {
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
				expiresAt: Date.now() + 15_000,
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
		if (armed.speakerKey !== speakerKey) {
			return null;
		}
		await this.ctx.storage.delete(WAKE_ARM_KEY);
		return { text: input.text, armed: true };
	}

	private async dispatchTurn(turn: PendingTurn): Promise<void> {
		const endpointedAt = Date.now();
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
		const accepted =
			(await this.floor.flushPendingInterrupt()) &&
			turn.voiceGeneration === this.floor.generation
				? await this.postToFabric("/api/internal/parlume/turns", turn)
				: null;
		if (accepted) {
			const handoffMs = Date.now() - endpointedAt;
			const body: unknown = await accepted.json().catch(() => null);
			log("info", "turn.dispatched", {
				sessionId: turn.sessionId,
				botId: turn.botId,
				voiceGeneration: turn.voiceGeneration,
				requestChars: turn.text.length,
				// Wake phrase to the end of the request, then to Fabric's accept.
				endpointMs: endpointedAt - this.wokeAt,
				handoffMs,
				// Fabric's own steps, from when its handler started.
				fabricTiming:
					isRecord(body) && isRecord(body.timing)
						? body.timing
						: null,
			});
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
			await this.schedulePendingRetry(
				bridge?.hardStopAt ? new Date(bridge.hardStopAt).getTime() : 0,
			);
			return;
		}
		pending.push(turn);
		await this.ctx.storage.put(PENDING_TURNS_KEY, pending);
		await this.ctx.storage.setAlarm(Date.now() + TURN_RETRY_MS);
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
			if (
				!turn ||
				!(await this.postToFabric("/api/internal/parlume/turns", turn))
			) {
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
			const hardStopAt = bridge?.hardStopAt
				? new Date(bridge.hardStopAt).getTime()
				: 0;
			if (Number.isFinite(hardStopAt) && hardStopAt > Date.now()) {
				await this.ctx.storage.setAlarm(hardStopAt);
			}
			return true;
		}
		const bridge = await this.ctx.storage.get<BridgeState>("bridge");
		await this.schedulePendingRetry(
			bridge?.hardStopAt ? new Date(bridge.hardStopAt).getTime() : 0,
		);
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
			await this.schedulePendingRetry(
				bridge.hardStopAt ? new Date(bridge.hardStopAt).getTime() : 0,
			);
			return "retry";
		}
		try {
			const payload: unknown = await response.json();
			return isRecord(payload) && payload.captureStopped === true
				? "stopped"
				: "active";
		} catch {
			await this.schedulePendingRetry(
				bridge.hardStopAt ? new Date(bridge.hardStopAt).getTime() : 0,
			);
			return "retry";
		}
	}
}
