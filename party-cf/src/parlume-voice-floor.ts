import {
	type ParlumeAuraOutlet,
	ParlumeReplyParts,
	type ParlumeSentenceFeed,
	parlumeAuraRetryLog,
	playParlumeAuraSentences,
	readParlumeSentenceLines,
} from "./parlume-aura";
import { parlumeChatSpeech } from "./parlume-chat";
import {
	ParlumeMeetingOutlet,
	parlumeNotingOutlet,
} from "./parlume-meeting-outlet";
import { readParlumeSpeech } from "./parlume-pcm";
import {
	ParlumeSpokenRecords,
	parlumeSentenceList,
	parlumeSentencesOf,
} from "./parlume-reply-record";
import { ParlumeRequestQueue, parlumeGreeted } from "./parlume-request-queue";
import {
	type ParlumeSpeechGate,
	type ParlumeSpeechStopCause,
	type ParlumeStopActor,
	type ParlumeStopDetection,
	type ParlumeStopResult,
	type ParlumeTurnStop,
	parlumeFirstName,
	parlumeTurnStop,
} from "./parlume-stop";
import type {
	ParlumeFloorStream,
	ParlumeVoiceFloorHost,
} from "./parlume-voice-floor-host";

const TURN_RETRY_MS = 2_000;
const MAX_SPEECH_BYTES = 6 * 1024 * 1024;
const VOICE_GENERATION_KEY = "voiceGeneration";
const RESPONSE_PENDING_KEY = "responsePending";
const PENDING_INTERRUPT_KEY = "pendingInterrupt";
const STOPPED_THROUGH_KEY = "stoppedThrough";
const READ_FAILED_LINE =
	"**Not read aloud** · My voice failed twice on that read. The text is still here in the chat.";

interface PendingInterrupt {
	sessionId: string;
	botId: string | null;
	voiceGeneration: number;
	stop?: ParlumeTurnStop;
}

/**
 * Who holds the meeting's floor: which reply generation is current, whether
 * Parlume is audible or still answering, the meeting's audio outlet, and the
 * order in which what it says is heard. Both voice engines play through it,
 * so a stop behaves the same whichever one is speaking. Nothing anyone says
 * over Parlume cuts it short: only a stop does (`stop`). A request that comes
 * meanwhile, spoken, typed or a read aloud, waits in `requests` for the
 * answer before it. A reply outlives a socket swap (`joinSocket`), and what
 * a restart cut short is resumed from `records`.
 */
export class ParlumeVoiceFloor<C, T> {
	readonly requests: ParlumeRequestQueue<T>;
	private readonly outlet: ParlumeMeetingOutlet<C>;
	private readonly records: ParlumeSpokenRecords;
	private playbackEpoch = 0;
	private playbackActive = false;
	// Bumped by every classic playback and whatever stops one: a playback
	// only ends `playbackActive` while it is still the latest, and a chat
	// post read aloud stops as soon as it is not.
	private playbackOwner = 0;
	// Each classic playback and read waits here for the one before it.
	private speechTurn: Promise<void> = Promise.resolve();
	// The text the bridge is reading aloud (a post, a notice), while it is
	// read: who asked for it, whether it is the join notice, and what lets
	// the realtime voice go on.
	private read: {
		owner: number;
		asker: string | null;
		joinNotice: boolean;
		release: ((said: boolean) => void) | null;
	} | null = null;
	// The sentences being synthesized for the playback in progress, the one
	// heard and the one after it.
	private said: string[] = [];
	// The latest reply generation that has sent the bot audio.
	private voicedGeneration: number | null = null;
	private responsePending = false;
	// The name of who asked for the reply, for the line that says it stopped.
	private asker: string | null = null;
	// The latest voice generation someone stopped: the worker posts nothing
	// more to the chat for it, or for any before it.
	private stoppedThrough: number | null = null;
	private readonly parts = new ParlumeReplyParts();
	// Reads asked for and not over yet, those waiting their turn included.
	private reads = 0;
	// The reply a request that waited opens with its asker's name.
	private greeting: { generation: number; name: string } | null = null;

	constructor(private readonly host: ParlumeVoiceFloorHost<T>) {
		this.outlet = new ParlumeMeetingOutlet<C>({ replies: host.replies });
		this.records = new ParlumeSpokenRecords(host.storage, Date.now);
		this.requests = new ParlumeRequestQueue<T>({
			storage: host.storage,
			busy: () => this.occupied(),
			whenVoiceQuiet: () => {
				const realtime = host.realtime();
				return realtime?.holdsFloor() ? realtime.whenQuiet() : null;
			},
			maySpeak: () => this.maySpeak(),
			startTurn: (turn) => host.startTurn(turn),
			read: (text, asker) =>
				this.speakHeld(text, asker, () => this.maySpeak()),
			postNotice: (text) => host.postNotice(text),
			log: (level, event, meta) =>
				host.log(level, event, {
					sessionId: host.sessionId(),
					...meta,
				}),
			now: () => Date.now(),
		});
	}

	async load(): Promise<void> {
		await this.requests.load();
		await this.records.load();
		const storage = this.host.storage;
		this.playbackEpoch =
			(await storage.get<number>(VOICE_GENERATION_KEY)) ?? 0;
		this.responsePending =
			(await storage.get<boolean>(RESPONSE_PENDING_KEY)) ?? false;
		this.stoppedThrough =
			(await storage.get<number>(STOPPED_THROUGH_KEY)) ?? null;
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

	/** Where both voices play, while a bot socket carries it. */
	meetingOutlet(): ParlumeAuraOutlet | null {
		return this.outlet.live ? this.outlet : null;
	}

	/** The bot connected again on `connection`: its speech waits for it. */
	joinSocket(connection: C, botId: string): void {
		this.outlet.join(connection, botId);
	}

	/**
	 * A verified socket carries the meeting's speech from now on: a reply
	 * the socket before it was playing goes on there, and a read a restart
	 * cut short is read on from its first unheard sentence.
	 */
	bindSocket(
		connection: C,
		botId: string,
		send: (frame: Uint8Array) => void,
	): void {
		const handOver = this.outlet.bind(connection, botId, send);
		if (handOver) {
			this.logResumed("socket_swap", handOver);
		}
		const cut = this.records.takeCutRead(this.playbackEpoch);
		if (cut) {
			const { asker, rest, ...resumed } = cut;
			this.logResumed("restart", { ...resumed, sentences: rest.length });
			void this.speakHeld(
				rest.join(" "),
				asker,
				() => this.maySpeak(),
				false,
				rest,
			);
		}
		this.requests.pump();
	}

	/** The socket closed, or a newer one took its place. */
	releaseSocket(connection: C): void {
		this.outlet.unbind(connection);
	}

	private logResumed(cause: string, meta: Record<string, number>): void {
		this.host.log("info", "speech.resumed", {
			sessionId: this.host.sessionId(),
			voiceGeneration: this.playbackEpoch,
			cause,
			...meta,
		});
	}

	/** The bot was sent the speech queued for it; null when none waits. */
	whenSpeechSent(): Promise<void> | null {
		return this.outlet.whenSent();
	}

	/** Why Parlume may not speak now, or null when it may. */
	stopCause(): ParlumeSpeechGate | null {
		if (!this.host.meetingOpen()) {
			return "cap";
		}
		if (this.host.paused()) {
			return "pause";
		}
		return this.host.guestPresent() ? "guest" : null;
	}

	/**
	 * The one gate every way of speaking checks, in both voices: the meeting
	 * is open, Parlume is not paused, and no external guest is in.
	 */
	maySpeak(): boolean {
		return this.stopCause() === null;
	}

	/** The meeting reached its cap: no sentence starts any more. */
	private pastCap(): boolean {
		return this.stopCause() === "cap";
	}

	/**
	 * The meeting reached its cap: the sentence being heard ends at its end,
	 * as no sentence starts past the cap, and once the outlet drains, or
	 * after `maxMs` at most, Parlume stops.
	 */
	async finishAtCap(maxMs: number): Promise<void> {
		let timer: ReturnType<typeof setTimeout> | null = null;
		await Promise.race([
			Promise.all([this.speechTurn, this.outlet.drained()]),
			new Promise<void>((resolve) => {
				timer = setTimeout(resolve, maxMs);
			}),
		]);
		clearTimeout(timer);
		await this.stop("cap");
	}

	/**
	 * The join notice tells everyone, guests included, that an AI assistant
	 * transcribes the meeting, so only the cap and a pause keep it unsaid.
	 */
	private mayGiveJoinNotice(): boolean {
		const cause = this.stopCause();
		return cause === null || cause === "guest";
	}

	/**
	 * Parlume stops, whether it is speaking, playing audio already queued, or
	 * still preparing an answer. Every outlet goes quiet before the first
	 * await, a reply still arriving in parts ends, and the realtime voice
	 * cancels and truncates its response, its audio still playing included.
	 * What waits to be read aloud after it stays queued, and so do the
	 * requests waiting in `requests`, unless the stop is a pause.
	 *
	 * A closed gate (the cap, a guest) lets the Fabric turn run on; its answer
	 * stays on the Parlume page, a guest coming in does not cut the join
	 * notice being said, and nothing waiting is answered. A stop someone
	 * asked for, or a pause, ends the
	 * answer: the turn is cancelled and recorded as STOPPED, and the worker
	 * posts nothing more for it. `detection` says how a stop said aloud was
	 * heard.
	 */
	async stop(
		cause: ParlumeSpeechStopCause,
		actor: ParlumeStopActor | null = null,
		detection: ParlumeStopDetection | null = null,
	): Promise<ParlumeStopResult> {
		const speaking = this.speaking;
		const reading =
			this.playbackActive && this.read?.owner === this.playbackOwner
				? this.read
				: null;
		const result = {
			stopped: speaking || this.isAnswering(),
			asker: reading ? reading.asker : this.asker,
		};
		const stop = parlumeTurnStop(cause, actor);
		const keepsJoinNotice =
			cause === "guest" && reading?.joinNotice === true;
		this.host.log("info", "speech.stopped", {
			sessionId: this.host.sessionId(),
			voiceGeneration: this.playbackEpoch,
			cause,
			actorId: actor?.id ?? null,
			speaking,
			stopped: result.stopped,
			keepsJoinNotice,
			...(detection ?? { detectMs: null, confirmed: null }),
		});
		if (stop) {
			if (result.stopped) {
				this.stoppedThrough = this.playbackEpoch;
				this.endReplyNow();
				await this.host.storage.put(
					STOPPED_THROUGH_KEY,
					this.stoppedThrough,
				);
				const bot = await this.host.bot();
				if (bot) {
					await this.noteInterrupt(bot, stop);
				}
			}
			// Only the answer stopped ends; a pause drops all that waits.
			if (cause === "pause") {
				await this.requests.clear();
			} else if (result.stopped) {
				await this.requests.afterStop();
			}
			return result;
		}
		const dropped = keepsJoinNotice ? 0 : this.clearOutlets();
		this.parts.close();
		if (!keepsJoinNotice) {
			this.playbackOwner++;
			this.playbackActive = false;
		}
		this.host.realtime()?.silence(dropped);
		if (!keepsJoinNotice) {
			this.releaseHeldRead();
		}
		await this.requests.clear();
		return result;
	}

	/**
	 * The read the realtime voice holds for was stopped: the voice goes on at
	 * once, without waiting for the read's synthesis to give up.
	 */
	private releaseHeldRead(): void {
		const release = this.read?.release;
		if (this.read) {
			this.read.release = null;
		}
		release?.(false);
	}

	/**
	 * Holds what Parlume is saying where it is, in both voices: a stop heard
	 * in a partial transcript waits for the final one to confirm it.
	 */
	holdSpeech(): void {
		this.outlet.hold("stop");
	}

	/** Goes on with the same speech `holdSpeech` held. */
	releaseSpeech(): void {
		this.outlet.release("stop");
	}

	/**
	 * The sentences of the classic playback in progress, to tell Parlume's
	 * own voice heard back from a participant's words.
	 */
	saying(): readonly string[] {
		return this.playbackActive ? this.said : [];
	}

	/** Whether the reply on this generation has sent the bot any audio. */
	hasSpoken(generation: number): boolean {
		return this.voicedGeneration === generation;
	}

	/** Whether the answer on this voice generation was stopped. */
	isStopped(generation: number): boolean {
		return (
			this.stoppedThrough !== null && generation <= this.stoppedThrough
		);
	}

	/** Whether speech for this generation may still be heard. */
	isVoiceCurrent(generation: number): boolean {
		return generation === this.playbackEpoch;
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

	/**
	 * Parlume is saying, reading or answering something a new request would
	 * have to wait for. A Fabric job the realtime voice started runs on while
	 * the conversation goes on, so it is not.
	 */
	private occupied(): boolean {
		return (
			this.isClassicAnswering() ||
			this.reads > 0 ||
			this.host.realtime()?.holdsFloor() === true
		);
	}

	/**
	 * The worker's `verify-generation`: whether its turn is still wanted,
	 * whether a bot socket plays speech now, and, for the reply `replyId`,
	 * how many of its sentences were heard, a restart before included.
	 */
	generationState(
		generation: number,
		replyId: string | null,
	): { current: boolean; live: boolean; heard?: number } {
		const heard =
			replyId === null ? null : this.records.heard(replyId, generation);
		return {
			current:
				this.host.realtime()?.hasJob(generation) === true ||
				(generation === this.playbackEpoch &&
					(this.responsePending ||
						this.host.chat.isChatTurnCurrent(this.playbackEpoch))),
			live: this.outlet.live,
			...(heard === null ? {} : { heard }),
		};
	}

	/**
	 * Starts a new reply generation; a spoken one holds the voice open.
	 * `asker` is the name of who asked for it; `greet`, for a request that
	 * waited, opens the spoken reply with it.
	 */
	async beginReply(
		voice: boolean,
		asker: string | null = null,
		greet = false,
	): Promise<number> {
		this.playbackEpoch++;
		this.responsePending = voice;
		this.asker = asker;
		const name = greet && voice ? parlumeFirstName(asker) : null;
		this.greeting = name ? { generation: this.playbackEpoch, name } : null;
		await this.host.storage.put({
			[VOICE_GENERATION_KEY]: this.playbackEpoch,
			[RESPONSE_PENDING_KEY]: voice,
		});
		return this.playbackEpoch;
	}

	/** The reply is over: whatever Parlume was saying or answering stops. */
	async interrupt(stream: ParlumeFloorStream): Promise<void> {
		this.endReplyNow();
		await this.noteInterrupt(stream);
	}

	// All at once, before the caller's first await: a part of the reply that
	// arrives next is already refused.
	private endReplyNow(): void {
		this.host.cancelEndpoint();
		const dropped = this.clearOutlets();
		this.parts.close();
		this.playbackEpoch++;
		this.playbackOwner++;
		this.playbackActive = false;
		this.responsePending = false;
		this.host.realtime()?.silence(dropped);
		this.releaseHeldRead();
	}

	/** Tells Fabric the turn is over: STOPPED when someone stopped it. */
	private async noteInterrupt(
		stream: ParlumeFloorStream,
		stop?: ParlumeTurnStop,
	): Promise<void> {
		await this.host.storage.put({
			[VOICE_GENERATION_KEY]: this.playbackEpoch,
			[RESPONSE_PENDING_KEY]: false,
		});
		await this.host.storage.put<PendingInterrupt>(PENDING_INTERRUPT_KEY, {
			sessionId: stream.sessionId,
			botId: stream.botId,
			voiceGeneration: this.playbackEpoch,
			...(stop ? { stop } : {}),
		});
		await this.flushPendingInterrupt();
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
	 * Waits for the classic playback or read before this one to end, and
	 * returns what lets the next one start.
	 */
	private async takeSpeechTurn(): Promise<() => void> {
		const previous = this.speechTurn;
		let done = () => {};
		this.speechTurn = new Promise<void>((resolve) => {
			done = resolve;
		});
		await previous;
		return done;
	}

	/**
	 * A read waits for the realtime voice to say and answer what it holds,
	 * then at most 1.5 s for the meeting to pause.
	 */
	private async readTurn(): Promise<void> {
		await this.host.realtime()?.whenQuiet();
		await this.requests.waitForPause();
	}

	/** Each sentence as it is synthesized, noted as said and in `record`. */
	private async *noted(
		sentences: AsyncIterable<string>,
		owner: number,
		record: number | null = null,
	): AsyncGenerator<string> {
		for await (const sentence of sentences) {
			if (owner === this.playbackOwner) {
				this.said = [...this.said.slice(-1), sentence];
			}
			if (record !== null) {
				this.records.noteSentence(record, sentence);
			}
			yield sentence;
		}
	}

	/**
	 * A classic playback or read takes the floor: the one before it is no
	 * longer current. Logs `speech.started` for the speech telemetry.
	 */
	private takePlayback(route: string, voiceGeneration: number): number {
		this.said = [];
		this.playbackActive = true;
		this.host.log("info", "speech.started", {
			sessionId: this.host.sessionId(),
			voice: "classic",
			route,
			voiceGeneration,
		});
		return ++this.playbackOwner;
	}

	/**
	 * Speaks text the bridge already holds (a chat post, a notice) once what
	 * Parlume is saying ends, in either voice: reads are heard in the order
	 * they were asked for, and none cuts the answer before it. `asker` is
	 * who asked for it, named if someone stops it; what they ask for while
	 * Parlume is busy waits in `requests`, and a long post is read in
	 * chapters. Both voices say it word for word, synthesized with Aura on the
	 * same outlet; the realtime voice holds its own answers meanwhile.
	 */
	speakLocally(
		text: string,
		asker: ParlumeStopActor | null = null,
	): Promise<boolean> {
		return this.requests.read(text, asker);
	}

	/**
	 * Say in meeting, from the Parlume page: read in its turn, word for word.
	 * False while Parlume may not speak (paused, a guest is in, past the cap)
	 * or no bot socket carries its voice.
	 */
	readAloud(text: string, asker: ParlumeStopActor): Promise<boolean> {
		if (!this.outlet.live) {
			return Promise.resolve(false);
		}
		return this.requests.offer(text, asker);
	}

	/** "Continue": the next chapter of a post read aloud, if one waits. */
	continueReading(actor: ParlumeStopActor | null): Promise<boolean> {
		return this.requests.continueReading(actor);
	}

	/**
	 * A notice of the bridge's own, such as a warning before the cap: read
	 * after what Parlume is saying, at a pause, when it may speak. A post's
	 * chapters waiting for "continue" stay as they are.
	 */
	speakNotice(text: string): Promise<boolean> {
		return this.speakHeld(text, null, () => this.maySpeak());
	}

	/**
	 * Says the join notice when the meeting chat cannot show it. It is the
	 * meeting's disclosure, so it is said while a guest is in, and a guest
	 * coming in does not cut it; the cap and a pause still keep it unsaid.
	 */
	speakJoinNotice(text: string): Promise<boolean> {
		return this.speakHeld(text, null, () => this.mayGiveJoinNotice(), true);
	}

	/**
	 * Reads `text` aloud as `sentences`: by default its own, and from the
	 * first unheard one when a restart cut the read short. Each read but the
	 * join notice is kept whole in `records`, with how much of it was heard.
	 */
	private async speakHeld(
		text: string,
		asker: string | null,
		mayContinue: () => boolean,
		joinNotice = false,
		sentences: readonly string[] | null = null,
	): Promise<boolean> {
		if (!mayContinue()) {
			return false;
		}
		this.reads++;
		const done = await this.takeSpeechTurn();
		let release: ((said: boolean) => void) | undefined;
		let said = false;
		let owner: number | null = null;
		let record: number | null = null;
		const outlet = this.outlet;
		try {
			const listed =
				sentences ??
				(await parlumeSentenceList(parlumeChatSpeech(text)));
			await this.readTurn();
			const stream = this.host.liveStream();
			if (!mayContinue() || !stream || !outlet.live) {
				return false;
			}
			release = this.host.realtime()?.holdForRead(text, 0);
			const current = this.takePlayback(
				"aura-bridge",
				this.playbackEpoch,
			);
			owner = current;
			this.read = {
				owner: current,
				asker,
				joinNotice,
				release: release ?? null,
			};
			const kept = joinNotice
				? null
				: this.records.beginRead(asker, this.playbackEpoch, listed);
			record = kept;
			const playback = await playParlumeAuraSentences({
				ai: this.host.aura,
				sentences: this.noted(parlumeSentencesOf(listed), current),
				outlet,
				// Past the cap the sentence being heard goes on to its end.
				isCurrent: () =>
					current === this.playbackOwner &&
					outlet.live &&
					(mayContinue() || this.pastCap()),
				endAtSentence: () => this.pastCap(),
				onRetry: parlumeAuraRetryLog(this.host.log, {
					sessionId: this.host.sessionId(),
					voiceGeneration: this.playbackEpoch,
					route: "aura-bridge",
				}),
				onHeard:
					kept === null
						? undefined
						: (heard) => void this.records.noteHeard(kept, heard),
			});
			this.host.log("info", "speech.synthesized", {
				sessionId: this.host.sessionId(),
				voiceGeneration: this.playbackEpoch,
				route: "aura-bridge",
				played: playback.complete,
				failedAt: playback.failedAt ?? null,
				sentences: playback.sentences.length,
			});
			// Failed twice: nobody else speaks it, so the chat says so once.
			if (playback.failedAt !== undefined && !joinNotice) {
				void this.host.postNotice(READ_FAILED_LINE);
			}
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
			said = playback.complete;
			return said;
		} catch {
			if (owner !== null && owner === this.playbackOwner) {
				outlet.clear();
			}
			return false;
		} finally {
			if (owner !== null && owner === this.playbackOwner) {
				this.playbackActive = false;
			}
			if (owner !== null && owner === this.read?.owner) {
				this.read = null;
			}
			if (record !== null) {
				void this.records.end(record);
			}
			this.reads--;
			release?.(said);
			done();
			this.requests.pump();
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
			const epoch = Number(
				request.headers.get("x-parlume-voice-generation") ??
					this.playbackEpoch,
			);
			return this.parts.add(
				request,
				replyId,
				part,
				this.isVoiceCurrent(epoch),
			);
		}
		const target = await this.playbackTarget(request);
		if (target instanceof Response) {
			if (replyId !== null) {
				this.parts.end(replyId);
			}
			return target;
		}
		const epoch = target;
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
			feed = this.parts.feed(replyId);
			const added = await this.parts.read(request, feed, 0);
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
		const greeting =
			this.greeting?.generation === epoch ? this.greeting.name : null;
		if (greeting) {
			this.greeting = null;
			sentences = parlumeGreeted(greeting, sentences);
		}
		const done = await this.takeSpeechTurn();
		const owner = this.takePlayback("aura", epoch);
		const startedAt = Date.now();
		const outlet = this.outlet;
		// A reply the worker withdrew stops at once, sent whole or not. One
		// the bot's socket swap held goes on on the new socket. Past the cap
		// the sentence being heard goes on to its end.
		const isCurrent = () =>
			this.isVoiceCurrent(epoch) &&
			outlet.live &&
			(this.maySpeak() || this.pastCap()) &&
			feed?.failed !== true;
		// Kept as it is heard, so a restart can tell the worker how far it got.
		const record =
			replyId === null ? null : this.records.beginReply(replyId, epoch);
		let handedOver = false;
		try {
			const playback = await playParlumeAuraSentences({
				ai: this.host.aura,
				sentences: this.noted(sentences, owner, record),
				outlet: parlumeNotingOutlet(outlet, () => {
					this.voicedGeneration = epoch;
				}),
				isCurrent,
				endAtSentence: () => this.pastCap(),
				onRetry: parlumeAuraRetryLog(this.host.log, {
					sessionId: this.host.sessionId(),
					voiceGeneration: epoch,
					route: "aura",
				}),
				onHeard:
					replyId === null || record === null
						? undefined
						: (heard) => {
								this.parts.noteHeard(replyId, heard);
								void this.records.noteHeard(record, heard);
							},
			}).catch((error: unknown) => {
				outlet.clear();
				throw error;
			});
			const played = playback.complete && isCurrent();
			handedOver = playback.failedAt !== undefined && isCurrent();
			this.host.log(handedOver ? "warn" : "info", "speech.synthesized", {
				sessionId: this.host.sessionId(),
				voiceGeneration: epoch,
				route: "aura",
				played,
				interrupted: !played && !handedOver,
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
				heard: playback.heard,
				firstAudioAt: playback.firstAudioAt,
				failedAt: playback.failedAt,
				error: playback.error,
				sentences: playback.sentences,
			});
		} finally {
			if (owner === this.playbackOwner) {
				this.playbackActive = false;
			}
			// Parts that arrive after the reply was played are refused.
			feed?.close();
			if (record !== null) {
				void this.records.end(record);
			}
			done();
			// A reply handed back to the worker is not over: its replacement
			// audio follows on this same generation.
			if (!handedOver && epoch === this.playbackEpoch) {
				this.responsePending = false;
				await this.host.storage.put(RESPONSE_PENDING_KEY, false);
			}
			this.requests.pump();
		}
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
		const epoch = target;
		if (!request.body) {
			return Response.json(
				{ error: "Missing PCM body" },
				{ status: 400 },
			);
		}
		const done = await this.takeSpeechTurn();
		const owner = this.takePlayback("pcm", epoch);
		const startedAt = Date.now();
		const outlet = this.outlet;
		const isCurrent = () =>
			this.isVoiceCurrent(epoch) && outlet.live && this.maySpeak();
		let firstAudioAt: number | undefined;
		try {
			const complete = await readParlumeSpeech({
				body: request.body,
				declaredLength: length,
				isCurrent,
				enqueue: (bytes) => {
					if (bytes.length > 0) {
						firstAudioAt ??= Date.now();
						this.voicedGeneration = epoch;
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
				firstAudioAt,
			};
			this.host.log("info", "speech.played", {
				sessionId: this.host.sessionId(),
				voiceGeneration: epoch,
				played: result.played,
				interrupted: result.interrupted,
				declaredBytes: length,
				sampleRate: outlet.sampleRate,
				playbackMs: Date.now() - startedAt,
			});
			return Response.json(result);
		} finally {
			if (owner === this.playbackOwner) {
				this.playbackActive = false;
			}
			done();
			if (epoch === this.playbackEpoch) {
				this.responsePending = false;
				await this.host.storage.put(RESPONSE_PENDING_KEY, false);
			}
			this.requests.pump();
		}
	}

	/**
	 * The voice generation a reply is played on, or the response that refuses
	 * it. Shared by `speak` (PCM from the worker) and `say` (text the bridge
	 * synthesizes itself).
	 */
	private async playbackTarget(request: Request): Promise<Response | number> {
		const stopped = this.stopCause();
		if (stopped === "cap") {
			return Response.json({ error: "Meeting ended" }, { status: 409 });
		}
		// Not heard, as a reply that was stopped is not: its answer stays on
		// the Parlume page.
		if (stopped !== null) {
			return Response.json({
				played: false,
				interrupted: true,
				heard: 0,
				stopped,
			});
		}
		// One bidirectional socket: the bot plays what it receives on the same
		// socket that carries the meeting audio.
		if (!this.outlet.live) {
			return Response.json(
				{ error: "Bot stream unavailable" },
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
				heard: 0,
			});
		}
		return epoch;
	}

	/** Silences the outlet; returns the bytes of speech that were dropped. */
	private clearOutlets(): number {
		const before = this.outlet.droppedBytes;
		this.outlet.clear();
		return this.outlet.droppedBytes - before;
	}
}
