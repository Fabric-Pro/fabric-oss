import {
	type ParlumeAuraBinding,
	ParlumeSentenceFeed,
	playParlumeAuraSentences,
	readParlumeSentenceLines,
	readParlumeSentencePart,
} from "./parlume-aura";
import {
	classifyParlumeBargeIn,
	type ParlumeBargeIn,
} from "./parlume-barge-in";
import { parlumeChatSpeech } from "./parlume-chat";
import type { ParlumeChatChannel } from "./parlume-chat-channel";
import { type ParlumeAudioOutlet, readParlumeSpeech } from "./parlume-pcm";
import type { ParlumeStreamConnection } from "./parlume-stream-auth";
import { parseParlumeWake } from "./parlume-wake";

const TURN_RETRY_MS = 2_000;
const MAX_SPEECH_BYTES = 6 * 1024 * 1024;
const VOICE_GENERATION_KEY = "voiceGeneration";
const RESPONSE_PENDING_KEY = "responsePending";
const PENDING_INTERRUPT_KEY = "pendingInterrupt";
const MUTED_GENERATION_KEY = "mutedGeneration";
/** The bridge's key for a speaker the meeting could not name. */
export const UNKNOWN_SPEAKER = "unknown";

export type ParlumeFloorStream = Pick<
	ParlumeStreamConnection,
	"sessionId" | "botId"
>;

interface PendingInterrupt {
	sessionId: string;
	botId: string | null;
	voiceGeneration: number;
}

/** What the voice floor needs from a realtime engine that is speaking. */
export interface ParlumeRealtimeVoice {
	/** Audio of one of its responses is queued or playing. */
	isPlaying(): boolean;
	/** A response is being produced, or a Fabric job it started is running. */
	isResponding(): boolean;
	/** A Fabric job it started on this voice generation is still running. */
	hasJob(generation: number): boolean;
	/** The speaker whose request it is answering, when one asked aloud. */
	requesterKey(): string | null;
	/**
	 * Parlume was silenced: the outlet has already dropped `droppedBytes` of
	 * queued speech. A cancel also ends the engine's running jobs.
	 */
	silence(kind: "mute" | "cancel", droppedBytes: number): void;
}

export interface ParlumeVoiceFloorHost<C> {
	storage: Pick<DurableObjectStorage, "get" | "put" | "delete" | "setAlarm">;
	sessionId(): string;
	aura: ParlumeAuraBinding;
	chat: Pick<ParlumeChatChannel, "beginChatTurn" | "isChatTurnCurrent">;
	postToFabric(path: string, body: object): Promise<Response | null>;
	/** The verified bot socket replies are played on, and its stream. */
	liveConnection(): { connection: C; stream: ParlumeFloorStream } | null;
	isConnected(connection: C): boolean;
	/** The meeting has not reached its hard stop. */
	meetingOpen(): Promise<boolean>;
	/** Drops a woken request still waiting for its speaker to finish. */
	cancelEndpoint(): void;
	realtime(): ParlumeRealtimeVoice | null;
	log(
		level: "info" | "warn" | "error",
		event: string,
		meta: Record<string, unknown>,
	): void;
}

/**
 * Who holds the meeting's floor: which reply generation is current, whether
 * Parlume is audible or still answering, the bot's audio outlets, and what a
 * participant's words do to a reply in progress. Both voice engines play
 * through it, so barge-in behaves the same whichever one is speaking.
 */
export class ParlumeVoiceFloor<C> {
	private readonly outlets = new Map<C, ParlumeAudioOutlet>();
	private playbackEpoch = 0;
	// The generation someone spoke over: its turn runs on, but it is no longer
	// heard, and the rest of its answer goes to the chat.
	private mutedGeneration: number | null = null;
	private playbackActive = false;
	private responsePending = false;
	// The speaker whose spoken request the classic reply answers. Only their
	// words, or words addressed to Parlume, may stop it.
	private requester: string | null = null;
	// The latest reply sent in parts, kept after it ends so that a part
	// arriving late is refused rather than starting a reply of its own.
	private reply: { id: string; feed: ParlumeSentenceFeed } | null = null;

	constructor(private readonly host: ParlumeVoiceFloorHost<C>) {}

	async load(): Promise<void> {
		const storage = this.host.storage;
		this.playbackEpoch =
			(await storage.get<number>(VOICE_GENERATION_KEY)) ?? 0;
		this.responsePending =
			(await storage.get<boolean>(RESPONSE_PENDING_KEY)) ?? false;
		this.mutedGeneration =
			(await storage.get<number>(MUTED_GENERATION_KEY)) ?? null;
	}

	get generation(): number {
		return this.playbackEpoch;
	}

	/** Parlume is audible, through either engine. */
	get speaking(): boolean {
		return (
			this.playbackActive || this.host.realtime()?.isPlaying() === true
		);
	}

	/** Parlume is audible or a spoken reply is on its way. */
	get busy(): boolean {
		return this.speaking || this.responsePending;
	}

	outlet(connection: C): ParlumeAudioOutlet | undefined {
		return this.outlets.get(connection);
	}

	setOutlet(connection: C, outlet: ParlumeAudioOutlet): void {
		this.outlets.get(connection)?.stop();
		this.outlets.set(connection, outlet);
	}

	dropOutlet(connection: C): void {
		this.outlets.get(connection)?.stop();
		this.outlets.delete(connection);
	}

	/** Whether speech for this generation may still be heard. */
	isVoiceCurrent(generation: number): boolean {
		return (
			generation === this.playbackEpoch &&
			generation !== this.mutedGeneration
		);
	}

	/** A reply of the classic engine is being spoken or answered. */
	isClassicAnswering(): boolean {
		return (
			this.playbackActive ||
			this.responsePending ||
			this.host.chat.isChatTurnCurrent(this.playbackEpoch)
		);
	}

	isAnswering(): boolean {
		return (
			this.isClassicAnswering() ||
			this.host.realtime()?.isResponding() === true
		);
	}

	/** The worker's `verify-generation`: whether its turn is still wanted. */
	generationState(generation: number): { current: boolean; muted: boolean } {
		const current =
			this.host.realtime()?.hasJob(generation) === true ||
			(generation === this.playbackEpoch &&
				(this.responsePending ||
					this.host.chat.isChatTurnCurrent(this.playbackEpoch)));
		return {
			current,
			muted: current && this.mutedGeneration === generation,
		};
	}

	/**
	 * Starts a new reply generation; a spoken one holds the voice open.
	 * `requester` is the speaker who asked aloud; a reply nobody asked aloud
	 * for may be stopped by anyone.
	 */
	async beginReply(
		voice: boolean,
		requester: string | null = null,
	): Promise<number> {
		this.playbackEpoch++;
		this.responsePending = voice;
		this.requester = requester;
		await this.host.storage.put({
			[VOICE_GENERATION_KEY]: this.playbackEpoch,
			[RESPONSE_PENDING_KEY]: voice,
		});
		return this.playbackEpoch;
	}

	/** The reply is over: whatever Parlume was saying or answering stops. */
	async interrupt(stream: ParlumeFloorStream): Promise<void> {
		this.host.cancelEndpoint();
		const dropped = this.clearOutlets();
		this.reply?.feed.close();
		this.playbackEpoch++;
		this.playbackActive = false;
		this.responsePending = false;
		await this.host.storage.put({
			[VOICE_GENERATION_KEY]: this.playbackEpoch,
			[RESPONSE_PENDING_KEY]: false,
		});
		this.host.realtime()?.silence("cancel", dropped);
		await this.host.storage.put<PendingInterrupt>(PENDING_INTERRUPT_KEY, {
			sessionId: stream.sessionId,
			botId: stream.botId,
			voiceGeneration: this.playbackEpoch,
		});
		await this.flushPendingInterrupt();
	}

	/**
	 * Someone spoke over Parlume. The reply goes quiet at once, but its turn
	 * runs on and finishes in the meeting chat, where a wake phrase, a cancel
	 * phrase or "stop" still cancels it as they cancel a chat-answered turn.
	 * A realtime reply just stops; the conversation carries on.
	 */
	async mute(stream: ParlumeFloorStream): Promise<void> {
		const realtime = this.host.realtime();
		if (realtime?.isPlaying()) {
			realtime.silence("mute", this.clearOutlets());
			return;
		}
		if (!this.playbackActive) {
			return;
		}
		this.clearOutlets();
		// A reply still waiting for its next part ends now, not when it comes.
		this.reply?.feed.close();
		this.playbackActive = false;
		this.mutedGeneration = this.playbackEpoch;
		const answering = this.responsePending;
		this.responsePending = false;
		if (answering) {
			this.host.chat.beginChatTurn(this.playbackEpoch);
		}
		await this.host.storage.put({
			[MUTED_GENERATION_KEY]: this.playbackEpoch,
			[RESPONSE_PENDING_KEY]: false,
		});
		this.host.log("info", "speech.muted", {
			sessionId: stream.sessionId,
			botId: stream.botId,
			voiceGeneration: this.playbackEpoch,
			answering,
		});
		// Fabric only notes it: the turn and its workflow carry on.
		if (answering && stream.botId) {
			await this.host.postToFabric("/api/internal/parlume/interrupt", {
				sessionId: stream.sessionId,
				botId: stream.botId,
				voiceGeneration: this.playbackEpoch,
				kind: "mute",
			});
		}
	}

	async flushPendingInterrupt(): Promise<boolean> {
		const storage = this.host.storage;
		const pending = await storage.get<PendingInterrupt>(
			PENDING_INTERRUPT_KEY,
		);
		if (!pending) {
			return true;
		}
		if (
			!(await this.host.postToFabric(
				"/api/internal/parlume/interrupt",
				pending,
			))
		) {
			await storage.setAlarm(Date.now() + TURN_RETRY_MS);
			return false;
		}
		const latest = await storage.get<PendingInterrupt>(
			PENDING_INTERRUPT_KEY,
		);
		if (latest?.voiceGeneration === pending.voiceGeneration) {
			await storage.delete(PENDING_INTERRUPT_KEY);
			return true;
		}
		return false;
	}

	/**
	 * Whether these words may stop the reply in progress: anyone's that
	 * address Parlume, and the requester's once their segment is final.
	 * Others talking among themselves while Parlume answers do not. A partial
	 * is never taken as the requester's (`speakerKey` null): Teams reports who
	 * starts and stops speaking seconds after the audio, so in a staging
	 * meeting a guest's side talk, a second in, was still put down to the
	 * requester who had just finished asking. A reply nobody asked for aloud,
	 * or whose requester was never named, can be stopped by anyone.
	 */
	private mayStop(speakerKey: string | null, text: string): boolean {
		const realtime = this.host.realtime();
		const requester =
			realtime?.isPlaying() || realtime?.isResponding()
				? realtime.requesterKey()
				: this.requester;
		return (
			requester === null ||
			requester === UNKNOWN_SPEAKER ||
			(speakerKey !== null && speakerKey === requester) ||
			parseParlumeWake(text) !== null
		);
	}

	// Speech only barges in while Parlume is audible, and only words that
	// want the floor: an acknowledgement ("yeah", "got it") does not. While
	// a request is being endpointed or answered, its speaker's continued
	// words extend it (`held`); Flux's empty start-of-turn events carry none.
	async onPartial(
		stream: ParlumeFloorStream,
		input: { fromBot: boolean; text: string; held: () => boolean },
	): Promise<void> {
		if (
			!input.fromBot &&
			input.text &&
			!input.held() &&
			this.speaking &&
			classifyParlumeBargeIn(input.text) !== "ignore" &&
			this.mayStop(null, input.text)
		) {
			await this.mute(stream);
		}
	}

	/**
	 * What a final segment does to the reply in progress. Returns its
	 * classification: a `cancel` phrase is never a request of its own.
	 */
	async onFinal(
		stream: ParlumeFloorStream,
		input: {
			fromBot: boolean;
			text: string;
			speakerId: string | null;
			speakerKey: string;
		},
	): Promise<ParlumeBargeIn> {
		const bargeIn = input.fromBot
			? "ignore"
			: classifyParlumeBargeIn(input.text);
		if (
			!input.fromBot &&
			this.responsePending &&
			parseParlumeWake(input.text) !== null
		) {
			await this.interrupt(stream);
		}
		const mayStop =
			bargeIn !== "ignore" && this.mayStop(input.speakerKey, input.text);
		if (bargeIn === "speech" && mayStop && this.speaking) {
			await this.mute(stream);
		}
		// "Stop", "never mind", "Parlume, wait": the answer is abandoned.
		if (bargeIn === "cancel" && mayStop && this.isAnswering()) {
			this.host.log("info", "turn.cancelled_by_speech", {
				sessionId: stream.sessionId,
				botId: stream.botId,
				speakerId: input.speakerId,
				voiceGeneration: this.playbackEpoch,
			});
			await this.interrupt(stream);
		}
		return bargeIn;
	}

	/**
	 * Speaks text the bridge already holds (a chat post, a notice) with Aura,
	 * as a reply of its own: whatever Parlume was saying or answering stops.
	 */
	async speakLocally(text: string): Promise<boolean> {
		const live = this.host.liveConnection();
		const outlet = live && this.outlets.get(live.connection);
		if (!live || !outlet) {
			return false;
		}
		const { connection, stream } = live;
		if (this.isAnswering()) {
			await this.interrupt(stream);
		}
		const epoch = ++this.playbackEpoch;
		await this.host.storage.put(VOICE_GENERATION_KEY, epoch);
		this.requester = null;
		this.playbackActive = true;
		try {
			const playback = await playParlumeAuraSentences({
				ai: this.host.aura,
				sentences: parlumeChatSpeech(text),
				outlet,
				isCurrent: () =>
					this.isVoiceCurrent(epoch) &&
					this.host.isConnected(connection),
			});
			this.host.log("info", "speech.synthesized", {
				sessionId: this.host.sessionId(),
				voiceGeneration: epoch,
				route: "aura-bridge",
				played: playback.complete,
				failedAt: playback.failedAt ?? null,
				sentences: playback.sentences.length,
			});
			const spoken = playback.sentences
				.filter((sentence) => sentence.ok)
				.map(({ chars, totalMs }) => ({ chars, totalMs }));
			if (spoken.length > 0) {
				void this.host.postToFabric(
					"/api/internal/parlume/speech-usage",
					{
						sessionId: stream.sessionId,
						botId: stream.botId,
						sentences: spoken,
					},
				);
			}
			return playback.complete;
		} catch {
			outlet.clear();
			return false;
		} finally {
			if (epoch === this.playbackEpoch) {
				this.playbackActive = false;
			}
		}
	}

	/**
	 * Speaks sentences sent as text: each is synthesized here with Aura and
	 * played in order, the next while the current one plays. A sentence that
	 * cannot be synthesized stops the reply and reports where, so the worker
	 * can speak the rest through its own routes.
	 *
	 * A reply named by `x-parlume-reply` comes in numbered parts: part 0 starts
	 * it and is answered when it has been played, every later part adds the
	 * sentences that exist by then, and the part marked last ends it. Without
	 * that header the body is the whole reply.
	 */
	async say(request: Request): Promise<Response> {
		if (request.headers.get("content-type") !== "application/x-ndjson") {
			return Response.json(
				{ error: "Invalid sentences" },
				{ status: 400 },
			);
		}
		const replyId = request.headers.get("x-parlume-reply");
		const part = Number(request.headers.get("x-parlume-reply-part") ?? 0);
		if (
			replyId !== null &&
			(!replyId || !Number.isSafeInteger(part) || part < 0)
		) {
			return Response.json(
				{ error: "Invalid reply part" },
				{ status: 400 },
			);
		}
		if (replyId !== null && part > 0) {
			return this.addReplyPart(request, replyId, part);
		}
		const target = await this.playbackTarget(request);
		if (target instanceof Response) {
			if (replyId !== null) {
				this.endReply(replyId);
			}
			return target;
		}
		const { connection, outlet, epoch } = target;
		let sentences: AsyncIterable<string>;
		let feed: ParlumeSentenceFeed | null = null;
		if (replyId === null) {
			if (!request.body) {
				return Response.json(
					{ error: "Missing sentences" },
					{ status: 400 },
				);
			}
			sentences = readParlumeSentenceLines(request.body);
		} else {
			feed = this.replyFeed(replyId);
			const added = await this.readReplyPart(request, feed, 0);
			if (added instanceof Response) {
				return added;
			}
			// Started once only: a repeated first part would play it twice.
			if (!added) {
				return Response.json(
					{ error: "Reply already started" },
					{ status: 409 },
				);
			}
			sentences = feed;
		}
		this.playbackActive = true;
		const startedAt = Date.now();
		const isCurrent = () =>
			this.isVoiceCurrent(epoch) && this.host.isConnected(connection);
		let handedOver = false;
		try {
			const playback = await playParlumeAuraSentences({
				ai: this.host.aura,
				sentences,
				outlet,
				isCurrent,
			}).catch((error: unknown) => {
				outlet.clear();
				throw error;
			});
			const played = playback.complete && isCurrent();
			handedOver = playback.failedAt !== undefined && isCurrent();
			const muted = epoch === this.mutedGeneration;
			this.host.log(handedOver ? "warn" : "info", "speech.synthesized", {
				sessionId: this.host.sessionId(),
				voiceGeneration: epoch,
				route: "aura",
				played,
				interrupted: !played && !handedOver,
				muted,
				heard: playback.heard,
				failedAt: playback.failedAt ?? null,
				error: playback.error ?? null,
				sentences: playback.sentences.length,
				chars: playback.sentences.reduce(
					(sum, sentence) => sum + sentence.chars,
					0,
				),
				totalMs: Date.now() - startedAt,
			});
			return Response.json({
				played,
				interrupted: !played && !handedOver,
				muted,
				heard: playback.heard,
				firstAudioAt: playback.firstAudioAt,
				failedAt: playback.failedAt,
				error: playback.error,
				sentences: playback.sentences,
			});
		} finally {
			this.playbackActive = false;
			// Parts that arrive after the reply was played are refused.
			feed?.close();
			// A reply handed back to the worker is not over: its replacement
			// audio follows on this same generation.
			if (!handedOver && epoch === this.playbackEpoch) {
				this.responsePending = false;
				await this.host.storage.put(RESPONSE_PENDING_KEY, false);
			}
		}
	}

	/**
	 * A later part of a reply sent in parts. It may arrive before the part
	 * that starts the reply, and is kept for it; a part for a generation that
	 * was spoken over or replaced, or for a reply already played, is refused.
	 * `x-parlume-reply-cancel` withdraws the reply: what is queued is dropped.
	 */
	private async addReplyPart(
		request: Request,
		replyId: string,
		part: number,
	): Promise<Response> {
		const epoch = Number(
			request.headers.get("x-parlume-voice-generation") ??
				this.playbackEpoch,
		);
		if (!this.isVoiceCurrent(epoch)) {
			this.endReply(replyId);
			return Response.json({ accepted: false });
		}
		const feed = this.replyFeed(replyId);
		if (request.headers.get("x-parlume-reply-cancel") === "1") {
			feed.fail(new Error("The reply was withdrawn"));
			return Response.json({ accepted: true });
		}
		const added = await this.readReplyPart(request, feed, part);
		return added instanceof Response
			? added
			: Response.json({ accepted: added });
	}

	private async readReplyPart(
		request: Request,
		feed: ParlumeSentenceFeed,
		part: number,
	): Promise<boolean | Response> {
		let sentences: string[];
		try {
			sentences = await readParlumeSentencePart(request.body);
		} catch {
			feed.fail(new Error("Invalid sentence"));
			return Response.json(
				{ error: "Invalid sentences" },
				{ status: 400 },
			);
		}
		return feed.add(
			part,
			sentences,
			request.headers.get("x-parlume-reply-last") === "1",
		);
	}

	/**
	 * Refuses the reply's later parts. A reply still being played under
	 * another id is left alone: a stale part must not end it.
	 */
	private endReply(replyId: string): void {
		if (
			!this.reply ||
			this.reply.id === replyId ||
			this.reply.feed.closed
		) {
			this.replyFeed(replyId).close();
		}
	}

	/** The feed of the reply sent in parts; a new reply ends the one before. */
	private replyFeed(replyId: string): ParlumeSentenceFeed {
		if (this.reply?.id !== replyId) {
			this.reply?.feed.close();
			this.reply = { id: replyId, feed: new ParlumeSentenceFeed() };
		}
		return this.reply.feed;
	}

	async speak(request: Request): Promise<Response> {
		const headerLength = request.headers.get("content-length");
		const length = headerLength === null ? null : Number(headerLength);
		if (
			request.headers.get("content-type") !== "audio/pcm" ||
			(length !== null &&
				(!Number.isFinite(length) ||
					length <= 0 ||
					length > MAX_SPEECH_BYTES ||
					length % 2 !== 0))
		) {
			return Response.json(
				{ error: "Invalid PCM audio" },
				{ status: 400 },
			);
		}
		const target = await this.playbackTarget(request);
		if (target instanceof Response) {
			return target;
		}
		const { connection, outlet, epoch } = target;
		if (!request.body) {
			return Response.json(
				{ error: "Missing PCM body" },
				{ status: 400 },
			);
		}
		this.playbackActive = true;
		const startedAt = Date.now();
		const isCurrent = () =>
			this.isVoiceCurrent(epoch) && this.host.isConnected(connection);
		let firstAudioAt: number | undefined;
		try {
			const complete = await readParlumeSpeech({
				body: request.body,
				declaredLength: length,
				isCurrent,
				enqueue: (bytes) => {
					if (bytes.length > 0) {
						firstAudioAt ??= Date.now();
						outlet.enqueue(bytes);
					}
				},
			}).catch((error: unknown) => {
				outlet.clear();
				throw error;
			});
			if (complete) {
				outlet.end();
				await outlet.drained();
			}
			const played = complete && isCurrent();
			const result = {
				played,
				interrupted: !played,
				muted: epoch === this.mutedGeneration,
				firstAudioAt,
			};
			this.host.log("info", "speech.played", {
				sessionId: this.host.sessionId(),
				voiceGeneration: epoch,
				played: result.played,
				interrupted: result.interrupted,
				muted: result.muted,
				declaredBytes: length,
				sampleRate: outlet.sampleRate,
				playbackMs: Date.now() - startedAt,
			});
			return Response.json(result);
		} finally {
			if (epoch === this.playbackEpoch) {
				this.playbackActive = false;
				this.responsePending = false;
				await this.host.storage.put(RESPONSE_PENDING_KEY, false);
			}
		}
	}

	/**
	 * The socket, outlet and voice generation a reply is played on, or the
	 * response that refuses it. Shared by `speak` (PCM from the worker) and
	 * `say` (text the bridge synthesizes itself).
	 */
	private async playbackTarget(
		request: Request,
	): Promise<
		Response | { connection: C; outlet: ParlumeAudioOutlet; epoch: number }
	> {
		if (!(await this.host.meetingOpen())) {
			return Response.json({ error: "Meeting ended" }, { status: 409 });
		}
		// One bidirectional socket: the bot plays what it receives on the same
		// socket that carries the meeting audio.
		const live = this.host.liveConnection();
		if (!live) {
			return Response.json(
				{ error: "Bot stream unavailable" },
				{ status: 409 },
			);
		}
		const outlet = this.outlets.get(live.connection);
		if (!outlet) {
			this.host.log("warn", "speech.no_meeting_audio", {
				sessionId: this.host.sessionId(),
			});
			return Response.json(
				{ error: "Bot audio unavailable" },
				{ status: 409 },
			);
		}
		const epoch = Number(
			request.headers.get("x-parlume-voice-generation") ??
				this.playbackEpoch,
		);
		if (!this.isVoiceCurrent(epoch)) {
			return Response.json({
				played: false,
				interrupted: true,
				muted: epoch === this.mutedGeneration,
				heard: 0,
			});
		}
		return { connection: live.connection, outlet, epoch };
	}

	/** Silences every outlet; returns the bytes of speech that were dropped. */
	private clearOutlets(): number {
		let dropped = 0;
		for (const outlet of this.outlets.values()) {
			const before = outlet.droppedBytes;
			outlet.clear();
			dropped += outlet.droppedBytes - before;
		}
		return dropped;
	}
}
