import {
	PARLUME_SPOKEN_BUDGET_SECONDS,
	parlumeSpokenPostText,
} from "./parlume-chat";
import {
	type ParlumeFabricResult,
	ParlumeVoiceAddresses,
} from "./parlume-fabric-result";
import {
	PARLUME_REALTIME_SAMPLE_RATE,
	ParlumeRealtimeClient,
	type ParlumeRealtimeEvent,
	type ParlumeRealtimeFunctionCall,
	type ParlumeRealtimeSocket,
	type ParlumeRealtimeUsage,
	parseParlumeRealtimeArguments,
	parseParlumeRealtimeTool,
} from "./parlume-realtime";
import {
	ParlumeRealtimeRotation,
	parlumeRealtimeCut,
	parlumeUnheardText,
} from "./parlume-realtime-continuity";
import type {
	ParlumeRealtimeContext,
	ParlumeRealtimeCut,
	ParlumeRealtimeEngineHost,
	ParlumeRealtimeRequester,
	ParlumeRealtimeResponseKind,
} from "./parlume-realtime-host";
import { ParlumeRealtimeAudioWindow } from "./parlume-realtime-listening";
import { PARLUME_RESUME_WINDOW_MS } from "./parlume-reply-record";
import type { ParlumeRealtimeVoice } from "./parlume-voice-floor-host";

// OpenAI ends a Realtime session when it expires; a fresh one takes over
// first, between answers (see `ParlumeRealtimeRotation`).
const ROTATE_RETRY_MS = 5_000;
const RECONNECT_BACKOFF_MS = [1_000, 3_000, 10_000];
const STABLE_SESSION_MS = 30_000;
const MAX_SUMMARY_LINES = 40;
// A wake phrase heard in a partial is answered when the voice hears the
// speaker stop. Flux refreshes it several times a second while they speak;
// one this stale was left by a partial that arrived after its own final, and
// on staging it answered other attendees' side talk ten seconds later.
const ARM_TTL_MS = 5_000;
// OpenAI's turn detection can end a turn at the pause in "Hey Fabric, what
// is…": answered then, the voice said "What do you want?" and then answered
// the request too. A request it ends is answered only once the speaker stays
// quiet this long, or at once when Flux says the turn has ended.
const WAKE_STOP_GRACE_MS = 600;
// While Fabric works, Parlume says it is on it at most this often. Each answer
// that started a job, and each that found one busy, used to say so again:
// three lines in six seconds for one request in a staging meeting.
const HOLDING_INTERVAL_MS = 10_000;
const QUEUED =
	"Fabric takes this request right after the one it is working on; nothing more to do. Say briefly that it is next.";
const MAX_LINE_CHARS = 400;
const MAX_REQUEST_CHARS = 2_000;
const MAX_CHAT_POST_CHARS = 3_900;
// A post is only queued until the meeting chat shows it, and a chat the
// organizer turned off never does; the bridge says when one did not show up.
const POSTING_NOT_SHOWN =
	"The chat has not shown it yet: say you are posting it there, never that it is there.";
const POSTED_SHOWN = "The meeting chat shows it now: you may say it is there.";
const BYTES_PER_MS = (PARLUME_REALTIME_SAMPLE_RATE * 2) / 1000;
// An answer someone asked for waits at most this long for whoever is talking
// to pause; a Fabric result nobody is waiting on waits for the pause, and
// goes to the meeting chat once it has waited this long.
const PAUSE_WAIT_MS = 1_500;
const RESULT_WAIT_MS = 60_000;
// In the meeting's last two minutes, to an asker the voice can no longer
// answer aloud.
const CLOSING_TYPE_REQUEST =
	"This meeting is close to its time limit, so I answer only in the chat now. Please type your request here.";
const CAPPED_LINE = `**Cut short** · That answer reached the ${PARLUME_SPOKEN_BUDGET_SECONDS}-second limit. Ask a narrower question, or ask me to put the answer in the chat.`;
const USAGE_KEYS = [
	"inputTextTokens",
	"inputAudioTokens",
	"cachedTextTokens",
	"cachedAudioTokens",
	"outputTextTokens",
	"outputAudioTokens",
] as const satisfies ReadonlyArray<keyof ParlumeRealtimeUsage>;

/** Text from elsewhere, inside a labelled block it cannot close early. */
function fence(tag: string, attributes: string, text: string): string {
	const body = text.replace(new RegExp(`<(/?)${tag}`, "gi"), `&lt;$1${tag}`);
	return `<${tag}${attributes}>\n${body}\n</${tag}>`;
}

/** What the voice is told of a Fabric job's outcome. */
function resultText(result: ParlumeFabricResult): string {
	if (result.status !== "completed") {
		return `Fabric could not finish ${result.job}.`;
	}
	// Told nothing, the voice said Fabric had posted a link it never posted.
	const inChat = result.chatTags.length
		? ` It is also being posted to the meeting chat as ${result.chatTags.join(", ")}; do not post it again. ${POSTING_NOT_SHOWN}`
		: " Nothing from this result is in the meeting chat; do not say it was posted.";
	return `Fabric finished ${result.job}.${inChat}\n${fence("fabric_result", ` job="${result.job}"`, result.text)}`;
}

/**
 * A tool output that leaves the asker nothing to wait for from the voice:
 * a Fabric job started, whose result comes back, or a post the chat has.
 */
function answeredWithoutVoice(output: object): boolean {
	return (
		("status" in output && output.status === "started") ||
		("posted" in output && output.posted === true) ||
		("reason" in output && output.reason === "already_posted")
	);
}

type ResponseKind = ParlumeRealtimeResponseKind;

type ConversationItem =
	| { role: "system" | "user"; text: string }
	| { callId: string; output: object };

interface QueuedResponse {
	kind: ResponseKind;
	items: ConversationItem[];
	/** What the response latency is measured from. */
	since: number;
	/** The meeting turn whose answer this response speaks. */
	turnId: string | null;
	/** The Fabric result it gives, said again if a chat post read cuts it. */
	result: ParlumeFabricResult | null;
	/** Who asked for it; a Fabric job it starts is theirs. */
	requester: ParlumeRealtimeRequester | null;
	/** What they asked, for a request: asked of Fabric when closing. */
	request: string | null;
	/** When it was first ready to start but for someone talking. */
	pauseSince: number | null;
	/** It waited `PAUSE_WAIT_MS` for a pause: it starts whoever talks. */
	pauseOver: boolean;
	resolve: (spoken: boolean) => void;
}

interface ResponseInFlight {
	id: string | null;
	kind: ResponseKind;
	since: number;
	turnId: string | null;
	result: ParlumeFabricResult | null;
	requester: ParlumeRealtimeRequester | null;
	firstAudioAt: number | null;
	/** Its audio deltas, in bytes, heard or not. */
	audioBytes: number;
	/** Its output transcript so far, kept for a resume if its session ends. */
	transcript: string;
	/** Audio of it arrived while there was no outlet to play it on. */
	unplayed: boolean;
	/** Its audio was stopped; the response itself runs on unless cancelled. */
	silenced: boolean;
	cancelled: boolean;
	/** Where to cut its audio item once it ends: what the meeting heard. */
	truncateAt: { itemId: string; playedMs: number } | null;
	resolve: (spoken: boolean) => void;
}

/**
 * Parlume's realtime voice for one meeting: the meeting's audio streams into
 * an OpenAI Realtime session continuously, and the session speaks only when
 * the bridge asks it to. It is asked when someone addresses Parlume (a wake
 * phrase, then the end of their speech), when a chat message wants a spoken
 * answer, when a chat post is to be read aloud, and when a Fabric job it
 * started has a result. Anything that needs Fabric runs as an ordinary
 * meeting turn while the conversation goes on.
 */
export class ParlumeRealtimeEngine implements ParlumeRealtimeVoice {
	private status: "idle" | "active" | "reconnecting" | "stopped" = "idle";
	private client: ParlumeRealtimeClient | null = null;
	private queue: QueuedResponse[] = [];
	private inFlight: ResponseInFlight | null = null;
	/** The assistant audio item being heard, and how many bytes of it were queued. */
	private audioItem: { itemId: string; bytes: number } | null = null;
	private playing = false;
	/** The response whose audio is playing, until it has played or is silenced. */
	private audible: ResponseInFlight | null = null;
	private reads = 0;
	/** The read the bridge is saying aloud, which holds the voice. */
	private reading: number | null = null;
	private playToken = 0;
	/** How often Parlume was silenced, so a drain can tell it was cut short. */
	private silences = 0;
	private addresses = new ParlumeVoiceAddresses();
	/** Refreshed by every partial that addresses Parlume; see `ARM_TTL_MS`. */
	private armed: {
		requester: string | null;
		speakerKey: string;
		/** The request as the bridge heard it so far. */
		request: string | null;
		at: number;
		/** A wake phrase said on its own listens, unanswered, until then. */
		awaitingUntil: number | null;
	} | null = null;
	/** The speaker last answered, until anyone speaks again. */
	private answered: string | null = null;
	private speechSinceAnswer = false;
	private vadSpeaking = false;
	private window = new ParlumeRealtimeAudioWindow();
	private jobs = new Map<
		string,
		{ generation: number; requester: ParlumeRealtimeRequester | null }
	>();
	/** Other participants' requests made while a job ran, in order. */
	private waiting: Array<{
		request: string;
		requester: ParlumeRealtimeRequester | null;
	}> = [];
	/** Starts the next response once it has waited long enough for a pause. */
	private pauseTimer: ReturnType<typeof setTimeout> | null = null;
	/** Answers a request OpenAI's turn detection ended (`WAKE_STOP_GRACE_MS`). */
	private stopTimer: ReturnType<typeof setTimeout> | null = null;
	/** What waits for the voice to give up the floor (`whenQuiet`). */
	private quietWaiters: Array<() => void> = [];
	private jobCounter = 0;
	/** Askers already asked to type their request at the cap, by speaker key. */
	private askedToType = new Set<string>();
	/** When Parlume last said aloud that it was working on a Fabric job. */
	private heldAt = Number.NEGATIVE_INFINITY;
	private lines: string[] = [];
	private connectedAt = 0;
	/** How near its end the session is; each phase pumps as it begins. */
	private readonly rotation = new ParlumeRealtimeRotation(
		() => this.host.now(),
		() => this.pump(),
	);
	private rotating = false;
	/** A response its session cut short, until its resume starts. */
	private cut: ParlumeRealtimeCut | null = null;
	private reconnectAttempts = 0;
	private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	private resumeTimer: ReturnType<typeof setTimeout> | null = null;
	private totals = {
		responses: 0,
		inputTextTokens: 0,
		inputAudioTokens: 0,
		cachedTextTokens: 0,
		cachedAudioTokens: 0,
		outputTextTokens: 0,
		outputAudioTokens: 0,
	};

	constructor(private readonly host: ParlumeRealtimeEngineHost) {}

	/** The engine owns the meeting's voice, reconnecting included. */
	get active(): boolean {
		return this.status === "active" || this.status === "reconnecting";
	}

	/** A session is open and hearing the meeting now. */
	get connected(): boolean {
		return this.status === "active" && this.client?.isOpen === true;
	}

	/**
	 * Carries on from the context the bridge saved before its Durable Object
	 * restarted: the meeting so far, the Fabric jobs still running, and the
	 * addresses Fabric gave, which the voice may still post.
	 */
	restore(context: ParlumeRealtimeContext): void {
		this.lines = context.lines.slice(-MAX_SUMMARY_LINES);
		this.jobs = new Map(
			context.jobs.map(({ job, generation, requester }) => [
				job,
				{ generation, requester: requester ?? null },
			]),
		);
		this.jobCounter = context.jobCounter;
		this.addresses = new ParlumeVoiceAddresses(context.addresses ?? []);
		// The answer the restart cut short goes on once a session is up.
		if (context.cut) {
			this.resume({ ...context.cut, cause: "restart" }, () => {});
		}
	}

	async start(): Promise<{ ok: true } | { ok: false; reason: string }> {
		const failure = await this.connect();
		if (failure !== null) {
			this.status = "stopped";
			return { ok: false, reason: failure };
		}
		this.status = "active";
		// A resume `restore` queued starts now.
		this.pump();
		return { ok: true };
	}

	stop(reason: string): void {
		if (this.status === "stopped") {
			return;
		}
		this.status = "stopped";
		this.clearTimers();
		this.client?.close(reason);
		this.client = null;
		if (this.inFlight) {
			this.drop(this.inFlight);
		}
		this.inFlight = null;
		for (const queued of this.queue.splice(0)) {
			this.drop(queued);
		}
		this.jobs.clear();
		this.waiting = [];
		this.cut = null;
		this.settleQuiet();
		this.host.log("info", "realtime.closed", { reason, ...this.totals });
	}

	/**
	 * Meeting audio reaches the session only while Parlume was addressed or
	 * is answering. When that ends, OpenAI's turn detection hears no more, so
	 * a turn it had open is dropped with the session's unfinished input.
	 */
	appendAudio(pcm: Uint8Array, sampleRate: number): void {
		const awaitingUntil = this.armed?.awaitingUntil ?? null;
		if (awaitingUntil !== null && this.host.now() > awaitingUntil) {
			this.host.log("info", "realtime.request_not_heard", {});
			this.armed = null;
		}
		const listening =
			this.armed !== null ||
			this.inFlight !== null ||
			this.queue.length > 0 ||
			this.playing ||
			this.reading !== null;
		if (
			this.client?.isOpen &&
			this.window.append(this.client, pcm, sampleRate, listening)
		) {
			this.vadSpeaking = false;
		}
	}

	/** A final line of the meeting, kept for the summary a new session starts from. */
	noteLine(speaker: string | null, text: string): void {
		this.lines.push(
			`${speaker ?? "Participant"}: ${text.slice(0, MAX_LINE_CHARS)}`,
		);
		if (this.lines.length > MAX_SUMMARY_LINES) {
			this.lines.splice(0, this.lines.length - MAX_SUMMARY_LINES);
		}
		this.saveContext();
	}

	/**
	 * Someone addressed Parlume. A wake phrase heard mid-utterance waits for
	 * the speaker to stop; one in a finished utterance is answered at once,
	 * unless that utterance was already answered. `request` is what the
	 * bridge heard after the wake phrase so far.
	 */
	arm(input: {
		requester: string | null;
		speakerKey: string;
		request: string;
		endOfTurn: boolean;
	}): void {
		if (!this.active || !this.host.maySpeak()) {
			return;
		}
		if (
			input.endOfTurn &&
			this.answered === input.speakerKey &&
			!this.speechSinceAnswer
		) {
			return;
		}
		this.listen(input, input.endOfTurn, null);
		if (input.endOfTurn) {
			this.answerArmed();
		}
	}

	/**
	 * A wake phrase said on its own: the request follows in the speaker's
	 * next words. Answered at once, "Hey, Fabric." got "I'm here.", and once
	 * that reply had played the voice stopped listening and lost the request
	 * said meanwhile. So the voice says nothing and listens on, for at most
	 * `forMs`, until `arm` hands it the request.
	 */
	awaitRequest(input: {
		requester: string | null;
		speakerKey: string;
		forMs: number;
	}): void {
		if (!this.active || !this.host.maySpeak()) {
			return;
		}
		this.listen(
			{ ...input, request: null },
			false,
			this.host.now() + input.forMs,
		);
	}

	private listen(
		input: {
			requester: string | null;
			speakerKey: string;
			request: string | null;
		},
		endOfTurn: boolean,
		awaitingUntil: number | null,
	): void {
		if (!this.armed) {
			this.host.log("info", "realtime.armed", {
				endOfTurn,
				requesterKnown: input.requester !== null,
				awaitingRequest: awaitingUntil !== null,
			});
		}
		this.armed = {
			requester: input.requester,
			speakerKey: input.speakerKey,
			request: input.request,
			at: this.host.now(),
			awaitingUntil,
		};
		if (this.client?.isOpen) {
			this.window.flush(this.client);
		}
	}

	/** "Parlume, stop" addressed Parlume, but it is not a request to answer. */
	disarm(): void {
		this.armed = null;
	}

	/**
	 * The meeting's last two minutes began: the request the voice was
	 * addressed for goes to the bridge's chat route, and what waits here is
	 * answered in the chat now (`answerInChat`).
	 */
	closeForCap(): void {
		this.armed = null;
		this.pump();
	}

	/**
	 * A spoken request the bridge resolved itself, such as "more on P3". The
	 * voice may already be answering the same utterance from its wake phrase;
	 * that answer heard the request too, so it is not answered twice.
	 */
	respondToRequest(
		speaker: string | null,
		speakerKey: string,
		text: string,
	): Promise<boolean> {
		if (this.answered === speakerKey && !this.speechSinceAnswer) {
			this.host.log("info", "realtime.request_already_answered", {});
			return Promise.resolve(false);
		}
		this.armed = null;
		this.answered = speakerKey;
		this.speechSinceAnswer = false;
		return this.respond(
			"wake",
			[
				{
					role: "user",
					text: `${speaker ?? "A participant"} asked:\n${fence("request", "", text)}`,
				},
			],
			null,
			{ name: speaker, key: speakerKey },
			text,
		);
	}

	/** A chat message that asked to be answered aloud: its typer asked. */
	respondToChat(
		speaker: string | null,
		text: string,
		speakerKey: string | null = null,
	): Promise<boolean> {
		return this.respond(
			"chat",
			[
				{
					role: "user",
					text: `${speaker ?? "A participant"} asked in the meeting chat for a spoken answer:\n${fence("chat_message", "", text)}`,
				},
			],
			null,
			{ name: speaker, key: speakerKey },
			text,
		);
	}

	/**
	 * The bridge reads text it holds (a chat post, a notice) aloud, word for
	 * word, in place of what Parlume is saying: the response in progress is
	 * cut short, and the voice says nothing more until the returned release
	 * is called. Fabric jobs and the answers queued for them are kept, and
	 * are spoken after the read, as is a Fabric result the read cut off. The
	 * outlet already dropped `droppedBytes` of queued speech. A response asked
	 * to read a post as written is not bound to its words, so the model does
	 * not read it.
	 */
	holdForRead(text: string, droppedBytes: number): (said: boolean) => void {
		if (!this.active) {
			return () => {};
		}
		const read = ++this.reads;
		this.reading = read;
		// A Fabric result the read cuts off is given again after it: "go"
		// stops only the voice, and a short result was in no chat post.
		const cut = this.resultsBeingGiven();
		this.quiet("hold", droppedBytes);
		this.queue.unshift(
			...cut.map(
				(result): QueuedResponse => ({
					kind: "result",
					items: [
						{
							role: "system",
							text: `A chat post was read aloud over your answer: give Fabric's result again. ${resultText(result)}`,
						},
					],
					since: this.host.now(),
					turnId: result.turnId ?? null,
					result,
					requester: null,
					request: null,
					pauseSince: null,
					pauseOver: false,
					resolve: () => {},
				}),
			),
		);
		return (said) => {
			if (this.reading !== read) {
				return;
			}
			this.reading = null;
			// The conversation knows what the meeting just heard.
			if (said) {
				this.client?.addMessage(
					"system",
					`This was just read aloud to the meeting, word for word:\n${fence("read_aloud", "", parlumeSpokenPostText(text))}`,
				);
			}
			this.pump();
		};
	}

	/** A Fabric job's outcome, spoken once nothing else is being said. */
	deliverResult(input: ParlumeFabricResult): boolean {
		const job = this.active ? this.jobs.get(input.job) : undefined;
		if (!job) {
			return false;
		}
		this.jobs.delete(input.job);
		this.addresses.noteResult(input.text);
		this.startWaiting();
		this.saveContext();
		this.host.log("info", "realtime.job_result", {
			job: input.job,
			status: input.status,
			chars: input.text.length,
			chatPosts: input.chatTags.length,
		});
		void this.respond(
			"result",
			[{ role: "system", text: resultText(input) }],
			input,
			job.requester,
		);
		return true;
	}

	/**
	 * The completed Fabric results whose answer is in progress or still
	 * playing. Each is taken from its response, which then reports no timing
	 * of its own: the answer given again reports the turn.
	 */
	private resultsBeingGiven(): ParlumeFabricResult[] {
		const given: ParlumeFabricResult[] = [];
		for (const response of new Set([this.audible, this.inFlight])) {
			if (response?.result?.status === "completed") {
				given.push(response.result);
				response.result = null;
				response.turnId = null;
			}
		}
		return given;
	}

	isPlaying(): boolean {
		return this.playing;
	}

	isResponding(): boolean {
		return (
			this.inFlight !== null ||
			this.queue.length > 0 ||
			this.jobs.size > 0
		);
	}

	/** Who asked for the answer being heard, or else the one being made. */
	requesterKey(): string | null {
		return (this.audible ?? this.inFlight)?.requester?.key ?? null;
	}

	holdsFloor(): boolean {
		return (
			this.status !== "stopped" &&
			(this.playing ||
				this.inFlight !== null ||
				this.queue.some((queued) => queued.kind !== "result"))
		);
	}

	whenQuiet(): Promise<void> {
		if (!this.holdsFloor()) {
			return Promise.resolve();
		}
		return new Promise((resolve) => this.quietWaiters.push(resolve));
	}

	private settleQuiet(): void {
		if (!this.holdsFloor()) {
			for (const resolve of this.quietWaiters.splice(0)) {
				resolve();
			}
		}
	}

	hasJob(generation: number): boolean {
		return [...this.jobs.values()].some(
			(job) => job.generation === generation,
		);
	}

	/** Parlume was stopped: what it says and is answering ends. */
	silence(droppedBytes: number): void {
		this.quiet("cancel", droppedBytes);
	}

	/**
	 * A hold, for a read aloud, stops only the audio: the response runs on to
	 * its end, so a request it hands to Fabric still reaches Fabric.
	 * Cancelling it lost such requests on staging. A cancel ends it as well,
	 * with what is queued and the jobs running.
	 */
	private quiet(kind: "hold" | "cancel", droppedBytes: number): void {
		const client = this.client;
		this.silences++;
		this.playing = false;
		this.audible = null;
		this.playToken++;
		const inFlight = this.inFlight;
		const item = this.audioItem;
		this.audioItem = null;
		if (inFlight) {
			inFlight.silenced = true;
			if (kind === "cancel" && !inFlight.cancelled) {
				inFlight.cancelled = true;
				client?.cancelResponse(inFlight.id);
			}
		} else if (kind === "cancel" && item) {
			client?.cancelResponse(null);
		}
		if (item && client) {
			const playedMs = Math.floor(
				Math.max(0, item.bytes - droppedBytes) / BYTES_PER_MS,
			);
			// A response still running writes on to its item: it is cut once
			// the response ends.
			if (
				inFlight &&
				!inFlight.cancelled &&
				inFlight.firstAudioAt !== null
			) {
				inFlight.truncateAt = { itemId: item.itemId, playedMs };
			} else {
				client.truncate(item.itemId, playedMs);
			}
			this.host.log("info", "realtime.truncated", {
				kind,
				playedMs,
				droppedMs: Math.round(droppedBytes / BYTES_PER_MS),
			});
		}
		if (kind === "cancel") {
			this.armed = null;
			for (const queued of this.queue.splice(0)) {
				this.drop(queued);
			}
			this.jobs.clear();
			this.waiting = [];
			// A stop ends a resume waiting to start as well: nothing is posted.
			this.endCut();
			this.saveContext();
		}
	}

	/** A response that will not be spoken; a job's answer reports it was cut. */
	private drop(response: QueuedResponse | ResponseInFlight): void {
		response.resolve(false);
		if (response.turnId !== null) {
			this.host.reportSpoken({
				turnId: response.turnId,
				firstAudioAt:
					"firstAudioAt" in response ? response.firstAudioAt : null,
				spokenAt: null,
				interrupted: true,
			});
		}
	}

	private saveContext(): void {
		// A restart resumes the cut waiting for its resume, or else the
		// response being heard, as far as it had played.
		const cut = this.cut ?? this.cutOf(this.inFlight, "restart");
		this.host.saveContext({
			lines: [...this.lines],
			jobs: [...this.jobs].map(([job, { generation, requester }]) => ({
				job,
				generation,
				requester,
			})),
			jobCounter: this.jobCounter,
			addresses: this.addresses.known(),
			...(cut ? { cut } : {}),
		});
	}

	/**
	 * The response in flight as its session's end would cut it (see
	 * `parlumeRealtimeCut`); null for one the meeting was not hearing.
	 */
	private cutOf(
		inFlight: ResponseInFlight | null,
		cause: ParlumeRealtimeCut["cause"],
	): ParlumeRealtimeCut | null {
		if (!inFlight?.transcript || inFlight.silenced || inFlight.cancelled) {
			return null;
		}
		return parlumeRealtimeCut(
			{ ...inFlight, audioMs: inFlight.audioBytes / BYTES_PER_MS },
			cause,
			this.host.now(),
		);
	}

	/**
	 * Its session ended before the response in flight did. One the meeting
	 * was hearing goes on in a resume response on the next session; any
	 * other is dropped.
	 */
	private cutShort(cause: ParlumeRealtimeCut["cause"]): void {
		const inFlight = this.inFlight;
		this.inFlight = null;
		if (!inFlight) {
			return;
		}
		const cut = this.cutOf(inFlight, cause);
		if (cut) {
			this.resume(cut, inFlight.resolve);
		} else {
			this.drop(inFlight);
		}
	}

	/**
	 * Queues the resume of `cut` first, to start as soon as a session can
	 * take it. When none has started it within `PARLUME_RESUME_WINDOW_MS`,
	 * what the meeting did not hear goes to its chat instead.
	 */
	private resume(
		cut: ParlumeRealtimeCut,
		resolve: (spoken: boolean) => void,
	): void {
		this.endCut();
		this.cut = cut;
		const heard = cut.transcript.slice(0, cut.heardChars).trim();
		this.queue.unshift({
			kind: "resume",
			items: [
				{
					role: "system",
					text: heard
						? `Your answer was cut off. The meeting heard you say:\n${fence("heard", "", heard)}\nGo on with the same answer from just after that. Do not repeat what was heard, and do not mention the interruption.`
						: "Your answer was cut off before the meeting heard it. Give that answer now.",
				},
			],
			since: this.host.now(),
			turnId: cut.turnId,
			result: cut.result,
			requester: cut.requester,
			request: null,
			pauseSince: null,
			pauseOver: false,
			resolve,
		});
		this.resumeTimer = setTimeout(() => {
			this.resumeMissed();
		}, PARLUME_RESUME_WINDOW_MS);
		this.saveContext();
	}

	/** The resume of the cut started on the new session. */
	private resumed(): void {
		const cut = this.cut;
		if (!cut) {
			return;
		}
		this.host.log("info", "speech.resumed", {
			cause: cut.cause,
			kind: cut.kind,
			gapMs: this.host.now() - cut.at,
			lostMs: cut.lostMs,
			heardChars: cut.heardChars,
		});
		this.endCut();
		this.saveContext();
	}

	private endCut(): void {
		if (this.resumeTimer) {
			clearTimeout(this.resumeTimer);
		}
		this.resumeTimer = null;
		this.cut = null;
	}

	/**
	 * No resume started in time: the part the meeting did not hear goes to
	 * its chat, all of a Fabric result's answer, its headline included. At
	 * the meeting's last two minutes the resume is not missed but moved to
	 * the chat on purpose, so it is logged apart and not counted as a fault.
	 */
	private resumeMissed(closing = false): void {
		if (this.resumeTimer) {
			clearTimeout(this.resumeTimer);
		}
		this.resumeTimer = null;
		const cut = this.cut;
		if (!cut) {
			return;
		}
		this.cut = null;
		const index = this.queue.findIndex(
			(queued) => queued.kind === "resume",
		);
		if (index >= 0) {
			this.queue.splice(index, 1)[0]?.resolve(false);
		}
		const unheard = parlumeUnheardText(cut);
		this.host.log(
			closing ? "info" : "warn",
			closing ? "realtime.resume_to_chat" : "realtime.resume_missed",
			{
				cause: cut.cause,
				kind: cut.kind,
				waitedMs: this.host.now() - cut.at,
				unheardChars: unheard.length,
			},
		);
		if (unheard) {
			void this.host.postChat(unheard.slice(0, MAX_CHAT_POST_CHARS));
		}
		if (cut.turnId) {
			this.host.reportSpoken({
				turnId: cut.turnId,
				firstAudioAt: null,
				spokenAt: null,
				interrupted: true,
			});
		}
		this.saveContext();
		this.settleQuiet();
	}

	private answerAfterPause(): void {
		this.cancelStopTimer();
		if (!this.armed || this.armed.awaitingUntil !== null) {
			return;
		}
		this.stopTimer = setTimeout(() => {
			this.stopTimer = null;
			this.answerArmed();
		}, WAKE_STOP_GRACE_MS);
	}

	private cancelStopTimer(): void {
		if (this.stopTimer) {
			clearTimeout(this.stopTimer);
			this.stopTimer = null;
		}
	}

	private answerArmed(): void {
		this.cancelStopTimer();
		const armed = this.armed;
		if (!armed || armed.awaitingUntil !== null) {
			return;
		}
		this.armed = null;
		const ageMs = this.host.now() - armed.at;
		if (ageMs > ARM_TTL_MS) {
			this.host.log("info", "realtime.arm_expired", { ageMs });
			return;
		}
		this.answered = armed.speakerKey;
		this.speechSinceAnswer = false;
		// Flux heard the end of the request before OpenAI's turn detection did:
		// the request's audio becomes a turn of its own now.
		if (this.vadSpeaking) {
			this.client?.commitAudio();
		}
		void this.respond(
			"wake",
			[
				{
					role: "system",
					text: `${armed.requester ?? "A participant"} just addressed you. Answer them now.`,
				},
			],
			null,
			{ name: armed.requester, key: armed.speakerKey },
			armed.request,
		);
	}

	/**
	 * Queues a response. A request answered after another answer opens with
	 * its asker's name, so the meeting hears whose turn it is.
	 */
	private respond(
		kind: ResponseKind,
		items: ConversationItem[],
		result: ParlumeFabricResult | null = null,
		requester: ParlumeRealtimeRequester | null = null,
		request: string | null = null,
	): Promise<boolean> {
		if (!this.active) {
			return Promise.resolve(false);
		}
		const behind =
			this.inFlight !== null || this.playing || this.queue.length > 0;
		const waiting =
			behind && (kind === "wake" || kind === "chat")
				? requester?.name
				: null;
		return new Promise((resolve) => {
			const queued: QueuedResponse = {
				kind,
				items: waiting
					? [
							...items,
							{
								role: "system",
								text: `${waiting} asked while you were answering. Start your answer with their name.`,
							},
						]
					: items,
				since: this.host.now(),
				turnId: result?.turnId ?? null,
				result,
				requester,
				request,
				pauseSince: null,
				pauseOver: false,
				resolve,
			};
			this.queue.push(queued);
			this.pump();
		});
	}

	private pump(): void {
		this.startNext();
		this.rotateIfDue();
		this.settleQuiet();
	}

	/**
	 * Starts the next queued response once the last one is done. Only one
	 * response writes to the conversation at a time, in the order they were
	 * asked for (`mayStartWhileTalking`). A meeting turn's answer also waits
	 * for earlier speech to finish playing, so it is heard as soon as its
	 * audio is queued and its timing is what was heard. Nothing starts while
	 * the bridge reads something aloud, nor while the session is being
	 * replaced or is about to be.
	 */
	private startNext(): void {
		// Parlume may not speak (a guest is in, it is paused, the meeting is
		// past its cap): nothing queued will be said.
		if (!this.host.maySpeak()) {
			for (const queued of this.queue.splice(0)) {
				this.drop(queued);
			}
			// Nor is the rest of an answer a session's end cut short posted.
			if (this.cut) {
				this.endCut();
				this.saveContext();
			}
			return;
		}
		// In the meeting's last two minutes nothing more is said: what waits
		// is answered in the chat.
		if (this.host.closing()) {
			for (const queued of this.queue.splice(0)) {
				this.answerInChat(queued);
			}
			return;
		}
		const client = this.client;
		const next = this.queue[0];
		if (
			!next ||
			!client?.isOpen ||
			this.status !== "active" ||
			this.inFlight ||
			this.reading !== null ||
			this.rotating ||
			this.rotation.holding ||
			(this.vadSpeaking && !this.mayStartWhileTalking(next)) ||
			(next.turnId !== null && this.playing)
		) {
			return;
		}
		this.queue.shift();
		client.flushAudio();
		for (const item of next.items) {
			if ("callId" in item) {
				client.addFunctionOutput(item.callId, item.output);
			} else {
				client.addMessage(item.role, item.text);
			}
		}
		client.createResponse(next.kind);
		this.inFlight = {
			id: null,
			kind: next.kind,
			since: next.since,
			turnId: next.turnId,
			result: next.result,
			requester: next.requester,
			firstAudioAt: null,
			audioBytes: 0,
			transcript: "",
			unplayed: false,
			silenced: false,
			cancelled: false,
			truncateAt: null,
			resolve: next.resolve,
		};
		this.host.log("info", "speech.started", {
			voice: "realtime",
			route: "realtime",
			kind: next.kind,
			voiceGeneration: this.host.generation(),
		});
		if (next.kind === "resume") {
			this.resumed();
		}
	}

	/**
	 * Whether the next response starts while someone is talking. The answer
	 * to a wake phrase starts at once: its asker has just stopped. Any other
	 * answer someone asked for waits at most `PAUSE_WAIT_MS` for a pause. A
	 * Fabric result waits for the pause, and after `RESULT_WAIT_MS` goes to
	 * the meeting chat instead.
	 */
	private mayStartWhileTalking(next: QueuedResponse): boolean {
		const now = this.host.now();
		switch (next.kind) {
			// The meeting was hearing it when its session ended.
			case "resume":
			case "wake":
				return true;
			case "chat":
			case "tool":
				next.pauseSince ??= now;
				if (next.pauseOver || now - next.pauseSince >= PAUSE_WAIT_MS) {
					return true;
				}
				this.pumpAfter(next.pauseSince + PAUSE_WAIT_MS - now, next);
				return false;
			case "result":
				if (now - next.since >= RESULT_WAIT_MS) {
					this.queue.shift();
					this.resultToChat(next);
					this.startNext();
					return false;
				}
				this.pumpAfter(next.since + RESULT_WAIT_MS - now, null);
				return false;
			default: {
				const unreachable: never = next.kind;
				return unreachable;
			}
		}
	}

	/** Pumps again in `ms`; `waiting` then no longer waits for a pause. */
	private pumpAfter(ms: number, waiting: QueuedResponse | null): void {
		if (this.pauseTimer) {
			clearTimeout(this.pauseTimer);
		}
		this.pauseTimer = setTimeout(() => {
			this.pauseTimer = null;
			if (waiting) {
				waiting.pauseOver = true;
			}
			this.pump();
		}, ms);
	}

	/** A Fabric result that waited too long for a pause, posted instead. */
	private resultToChat(queued: QueuedResponse): void {
		const result = queued.result;
		queued.resolve(false);
		this.host.log("info", "realtime.result_to_chat", {
			job: result?.job ?? null,
			waitedMs: this.host.now() - queued.since,
		});
		if (!result) {
			return;
		}
		const text =
			result.status !== "completed"
				? `Fabric could not finish ${result.job}. Ask me again.`
				: result.chatTags.length > 0
					? `Fabric finished ${result.job}: it is in the chat as ${result.chatTags.join(", ")}.`
					: result.text.slice(0, MAX_CHAT_POST_CHARS);
		if (text) {
			void this.host.postChat(text);
		}
		if (result.turnId) {
			this.host.reportSpoken({
				turnId: result.turnId,
				firstAudioAt: null,
				spokenAt: null,
				interrupted: false,
			});
		}
	}

	/**
	 * A response that waited into the meeting's last two minutes, answered
	 * in the chat as the classic voice answers there: a request is asked of
	 * Fabric, and its result is posted; a Fabric result is posted at once,
	 * and so is what the meeting did not hear of an answer cut short. A
	 * tool's follow-up gives the Fabric result it carries; when its tools
	 * left the asker without an answer, as a chat read or a refused post
	 * does, the asker is told to type the request instead, and so is an
	 * asker whose words the voice never heard or whose request came while
	 * Fabric was still working on another, which Fabric refuses as busy.
	 */
	private answerInChat(queued: QueuedResponse): void {
		switch (queued.kind) {
			case "wake":
			case "chat": {
				queued.resolve(false);
				const request = queued.request
					?.trim()
					.slice(0, MAX_REQUEST_CHARS);
				const busy = Boolean(request) && this.jobs.size > 0;
				const job =
					request && !busy
						? this.startJob(request, queued.requester)
						: null;
				this.host.log("info", "realtime.request_to_chat", {
					kind: queued.kind,
					job,
					busy,
				});
				if (!job) {
					this.askToType(queued.requester);
				}
				return;
			}
			case "result":
				this.resultToChat(queued);
				return;
			case "resume":
				queued.resolve(false);
				this.resumeMissed(true);
				return;
			case "tool": {
				if (queued.result) {
					this.resultToChat(queued);
				} else {
					this.drop(queued);
				}
				const unanswered =
					queued.result === null &&
					queued.items.some(
						(item) =>
							"output" in item &&
							!answeredWithoutVoice(item.output),
					);
				this.host.log("info", "realtime.tool_to_chat", { unanswered });
				if (unanswered) {
					this.askToType(queued.requester);
				}
				return;
			}
			default: {
				const unreachable: never = queued.kind;
				throw new Error(`Unknown response kind: ${unreachable}`);
			}
		}
	}

	/** Asks an asker the voice cannot answer to type the request, once each. */
	private askToType(requester: ParlumeRealtimeRequester | null): void {
		const key = requester?.key ?? null;
		if (key !== null) {
			if (this.askedToType.has(key)) {
				return;
			}
			this.askedToType.add(key);
		}
		void this.host.postChat(CLOSING_TYPE_REQUEST);
	}

	private onEvent(event: ParlumeRealtimeEvent): void {
		switch (event.type) {
			case "session_created":
				if (event.expiresAt !== null) {
					this.rotation.expireAt(event.expiresAt);
				}
				return;
			case "transcript_delta":
				this.noteTranscript(event);
				return;
			case "speech_started":
				this.vadSpeaking = true;
				this.speechSinceAnswer = true;
				this.cancelStopTimer();
				return;
			case "speech_stopped":
				this.vadSpeaking = false;
				this.answerAfterPause();
				this.pump();
				return;
			case "response_created":
				if (this.inFlight && this.inFlight.id === null) {
					this.inFlight.id = event.responseId;
				}
				return;
			case "audio_delta":
				this.play(event);
				return;
			case "response_done":
				this.finish(event);
				return;
			case "error":
				this.host.log("warn", "realtime.error", {
					code: event.code,
					param: event.param,
					message: event.message,
				});
				// A response the server refused to create never reports done. An
				// input audio error, such as a commit the server's own turn
				// detection made first, is not about the response: dropping it
				// lost the first request of a meeting on staging. Nor is a late
				// stop's cancel of a response that had already ended.
				if (
					this.inFlight &&
					this.inFlight.id === null &&
					!event.code?.startsWith("input_audio_buffer_") &&
					event.code !== "response_cancel_not_active"
				) {
					this.drop(this.inFlight);
					this.inFlight = null;
					this.pump();
				}
				return;
			default: {
				const unreachable: never = event;
				this.host.log("warn", "realtime.unhandled_event", {
					event: typeof unreachable,
				});
			}
		}
	}

	/**
	 * What the response says, as its audio streams: saved at each sentence
	 * end, so a restart can resume after what was heard.
	 */
	private noteTranscript(event: { responseId: string; delta: string }): void {
		const inFlight = this.inFlight;
		if (
			!inFlight ||
			(inFlight.id !== null && inFlight.id !== event.responseId)
		) {
			return;
		}
		inFlight.transcript += event.delta;
		if (/[.!?]\s*$/.test(event.delta)) {
			this.saveContext();
		}
	}

	private play(event: {
		responseId: string;
		itemId: string;
		audio: Uint8Array;
	}) {
		const inFlight = this.inFlight;
		if (
			!inFlight ||
			(inFlight.id !== null && inFlight.id !== event.responseId)
		) {
			return;
		}
		inFlight.audioBytes += event.audio.byteLength;
		if (inFlight.silenced || !this.host.maySpeak()) {
			return;
		}
		const outlet = this.host.outlet();
		if (!outlet) {
			if (!inFlight.unplayed) {
				inFlight.unplayed = true;
				this.host.log("warn", "realtime.audio_dropped", {
					kind: inFlight.kind,
					reason: "no_outlet",
					bytes: event.audio.byteLength,
				});
			}
			return;
		}
		// Audio is heard as it is queued: nothing of Parlume's plays ahead of
		// a meeting turn's answer (see `pump`).
		if (inFlight.firstAudioAt === null) {
			inFlight.firstAudioAt = this.host.now();
			this.host.log("info", "realtime.response", {
				kind: inFlight.kind,
				latencyMs: this.host.now() - inFlight.since,
			});
		}
		if (this.audioItem?.itemId !== event.itemId) {
			this.audioItem = { itemId: event.itemId, bytes: 0 };
		}
		outlet.enqueue(event.audio);
		this.audioItem.bytes += event.audio.byteLength;
		this.playing = true;
		this.audible = inFlight;
		this.playToken++;
	}

	private finish(event: {
		responseId: string;
		status: string;
		reason: string | null;
		usage: ParlumeRealtimeUsage | null;
		functionCalls: ParlumeRealtimeFunctionCall[];
		transcripts: string[];
	}): void {
		if (event.usage) {
			this.host.reportUsage(event.usage);
			this.totals.responses++;
			for (const key of USAGE_KEYS) {
				this.totals[key] += event.usage[key];
			}
		}
		const inFlight = this.inFlight;
		const tracked =
			inFlight !== null &&
			(inFlight.id === null || inFlight.id === event.responseId);
		if (tracked) {
			this.inFlight = null;
		}
		// Saved once the response is over, so a restart does not resume it.
		for (const transcript of event.transcripts) {
			this.noteLine("Parlume", transcript);
		}
		if (tracked && inFlight.transcript && event.transcripts.length === 0) {
			this.saveContext();
		}
		const audioBytes = tracked ? inFlight.audioBytes : 0;
		// How many audio tokens a second of speech costs is measured from
		// these, for the realtime session's output limit.
		this.host.log("info", "realtime.done", {
			status: event.status,
			reason: event.reason,
			outputAudioTokens: event.usage?.outputAudioTokens ?? null,
			outputTextTokens: event.usage?.outputTextTokens ?? null,
			audioBytes,
			audioMs: Math.round(audioBytes / BYTES_PER_MS),
		});
		if (
			event.status === "incomplete" &&
			event.reason === "max_output_tokens"
		) {
			this.host.log("info", "realtime.capped", {
				audioMs: Math.round(audioBytes / BYTES_PER_MS),
			});
			void this.host.postChat(CAPPED_LINE);
		}
		// The bridge alone cancels responses: OpenAI's turn detection
		// cancelling one means the session did not take its settings.
		if (event.status === "cancelled" && event.reason === "turn_detected") {
			this.host.log("warn", "realtime.misconfigured", {
				reason: event.reason,
			});
		}
		if (!tracked) {
			// A response the bridge lost track of still made its calls. Left
			// without an answer, an ask_fabric call read as a job still
			// running, and the voice turned every later request away.
			if (
				event.status === "completed" &&
				event.functionCalls.length > 0
			) {
				void this.answerCalls(event.functionCalls, false, null, null);
			}
			return;
		}
		if (inFlight.truncateAt) {
			this.client?.truncate(
				inFlight.truncateAt.itemId,
				inFlight.truncateAt.playedMs,
			);
		}
		const completed = event.status === "completed";
		const heard = completed && !inFlight.silenced;
		const drained = this.endPlayback();
		inFlight.resolve(heard);
		const calls =
			completed && !inFlight.cancelled ? event.functionCalls : [];
		const spoke = inFlight.firstAudioAt !== null;
		// A meeting turn's answer that only ran tools, such as a chat post,
		// is heard in the response that answers them: that one reports it.
		const carried = calls.length > 0 && !spoke ? inFlight.result : null;
		if (carried === null) {
			this.reportSpoken(inFlight, heard, drained);
		}
		if (calls.length > 0) {
			void this.answerCalls(
				calls,
				spoke,
				carried,
				inFlight.requester,
				inFlight.result?.chatTags ?? [],
			);
		}
		this.pump();
	}

	/**
	 * No more audio is coming for what is playing: resolves once the outlet
	 * has played it. With no outlet left to play it, such as after the bot's
	 * stream dropped, it is over now; otherwise a meeting turn's answer would
	 * wait for it forever (see `pump`).
	 */
	private endPlayback(): Promise<void> {
		if (!this.playing) {
			return Promise.resolve();
		}
		const outlet = this.host.outlet();
		if (!outlet) {
			this.playing = false;
			this.audible = null;
			this.audioItem = null;
			return Promise.resolve();
		}
		outlet.end();
		const token = this.playToken;
		const drained = outlet.drained();
		void drained.then(() => {
			if (token === this.playToken) {
				this.playing = false;
				this.audible = null;
				this.audioItem = null;
				this.pump();
			}
		});
		return drained;
	}

	/** A job's answer was heard to its end once played, unless silenced first. */
	private reportSpoken(
		inFlight: ResponseInFlight,
		completed: boolean,
		drained: Promise<void>,
	): void {
		if (inFlight.turnId === null) {
			return;
		}
		const silences = this.silences;
		void drained.then(() => {
			// A read aloud may have handed the turn to the answer given again.
			const turnId = inFlight.turnId;
			if (turnId === null) {
				return;
			}
			const interrupted = inFlight.silenced || this.silences !== silences;
			this.host.reportSpoken({
				turnId,
				firstAudioAt: inFlight.firstAudioAt,
				spokenAt:
					completed && !interrupted && inFlight.firstAudioAt !== null
						? this.host.now()
						: null,
				interrupted,
			});
		});
	}

	/**
	 * Answers the session's tool calls. A call that only started a Fabric job,
	 * or found one running, gets its answer quietly when the response that
	 * made it already spoke, or when Parlume said it was on it moments ago;
	 * otherwise the session would say so once more. `result` is the Fabric
	 * result whose answer made the calls without a word: the response that
	 * answers them gives that result, for its meeting turn. `requester` asked
	 * for the response that made them.
	 */
	private async answerCalls(
		calls: ParlumeRealtimeFunctionCall[],
		spoke: boolean,
		result: ParlumeFabricResult | null,
		requester: ParlumeRealtimeRequester | null,
		resultTags: readonly string[] = [],
	) {
		const items: Array<{ callId: string; output: object }> = [];
		let holdingOnly = true;
		for (const call of calls) {
			const output = await this.runTool(call, requester, resultTags);
			holdingOnly &&=
				"status" in output &&
				(output.status === "started" ||
					output.status === "busy" ||
					output.status === "queued");
			items.push({ callId: call.callId, output });
		}
		const now = this.host.now();
		if (holdingOnly && spoke) {
			this.heldAt = now;
		}
		const client = this.client;
		if (
			holdingOnly &&
			client?.isOpen &&
			(spoke || now - this.heldAt < HOLDING_INTERVAL_MS)
		) {
			for (const item of items) {
				client.addFunctionOutput(item.callId, item.output);
			}
			this.host.log("info", "realtime.holding_skipped", {
				spoke,
				sinceHeldMs: spoke ? 0 : now - this.heldAt,
			});
			if (result?.turnId) {
				this.host.reportSpoken({
					turnId: result.turnId,
					firstAudioAt: null,
					spokenAt: null,
					interrupted: false,
				});
			}
			return;
		}
		if (holdingOnly) {
			this.heldAt = now;
		}
		void this.respond("tool", items, result, requester);
	}

	private async runTool(
		call: ParlumeRealtimeFunctionCall,
		requester: ParlumeRealtimeRequester | null,
		resultTags: readonly string[],
	): Promise<object> {
		const tool = parseParlumeRealtimeTool(call.name);
		const args = parseParlumeRealtimeArguments(call.arguments);
		if (tool === null) {
			return { error: "unknown_tool" };
		}
		switch (tool) {
			case "ask_fabric":
				return this.askFabric(args, requester);
			case "post_to_chat":
				return this.postToChat(args, resultTags);
			case "read_chat":
				return { messages: this.host.readChat() };
			default: {
				const unreachable: never = tool;
				return unreachable;
			}
		}
	}

	/** Posts what the voice wrote, unless it holds an address Fabric did not give. */
	private async postToChat(
		args: Record<string, unknown>,
		resultTags: readonly string[],
	): Promise<object> {
		const text =
			typeof args.text === "string"
				? args.text.trim().slice(0, MAX_CHAT_POST_CHARS)
				: "";
		if (!text) {
			return { posted: false, reason: "empty" };
		}
		// Fabric posts a long result itself; the voice giving that result
		// posted the same list again as a second tag.
		if (resultTags.length > 0) {
			this.host.log("info", "realtime.chat_post_duplicate_refused", {
				tags: [...resultTags],
			});
			return {
				posted: false,
				reason: "already_posted",
				instruction: `Fabric is already posting this result to the meeting chat as ${resultTags.join(", ")}. Do not post it again; say it is being posted there.`,
			};
		}
		const unknown = this.addresses.unverified(text, this.host.readChat());
		if (unknown.length > 0) {
			this.host.log("info", "realtime.chat_address_refused", {
				addresses: unknown.length,
			});
			return {
				posted: false,
				reason: "address_not_from_fabric",
				instruction:
					"Nothing was posted. Never write a web address yourself: call ask_fabric with the participant's request for the link, and Fabric looks it up in this meeting's project and posts it, or says it could not be found.",
			};
		}
		const sent = await this.host.postChat(text);
		if (!sent.posted) {
			return sent;
		}
		// The model has said "I've posted it" despite being told to say it is
		// posting; once the chat shows the post, that line is true.
		return {
			posted: true,
			tag: sent.tag,
			instruction: sent.shown ? POSTED_SHOWN : POSTING_NOT_SHOWN,
		};
	}

	/**
	 * Starts a Fabric turn and answers at once, so the conversation goes on
	 * while Fabric works; the result comes back through `deliverResult`.
	 */
	private askFabric(
		args: Record<string, unknown>,
		requester: ParlumeRealtimeRequester | null,
	): object {
		const request =
			typeof args.request === "string"
				? args.request.trim().slice(0, MAX_REQUEST_CHARS)
				: "";
		if (!request) {
			return { status: "invalid", error: "request is required" };
		}
		if (this.jobs.size > 0) {
			const running = [...this.jobs.keys()];
			const key = requester?.key ?? null;
			const known = (other: ParlumeRealtimeRequester | null) =>
				other?.key === key;
			// Another participant's request waits for the job; the same
			// asker asking again is the request already running.
			if (
				key === null ||
				[...this.jobs.values()].some((job) => known(job.requester)) ||
				this.waiting.some((waiting) => known(waiting.requester))
			) {
				return { status: "busy", running };
			}
			this.waiting.push({ request, requester });
			this.host.log("info", "realtime.job_queued", {
				after: running,
				waiting: this.waiting.length,
			});
			return { status: "queued", after: running, instruction: QUEUED };
		}
		return { status: "started", job: this.startJob(request, requester) };
	}

	/** Hands the next waiting request to Fabric once no job runs. */
	private startWaiting(): void {
		const next = this.jobs.size === 0 ? this.waiting.shift() : undefined;
		if (next) {
			this.startJob(next.request, next.requester);
		}
	}

	/** Hands `request` to Fabric as a meeting turn; returns its job. */
	private startJob(
		request: string,
		requester: ParlumeRealtimeRequester | null,
	): string {
		const job = `J${++this.jobCounter}`;
		const generation = this.host.generation();
		this.jobs.set(job, { generation, requester });
		this.saveContext();
		this.host.log("info", "realtime.job_started", {
			job,
			voiceGeneration: generation,
			requestChars: request.length,
		});
		void this.host
			.dispatchJob({
				job,
				request,
				requester: requester?.name ?? null,
				requesterKey: requester?.key ?? null,
				generation,
			})
			.then((accepted) => {
				if (!accepted) {
					this.deliverResult({
						job,
						status: "failed",
						text: "",
						chatTags: [],
					});
				}
			});
		return job;
	}

	/** Opens a session; returns why it could not, or null once it is live. */
	private async connect(): Promise<string | null> {
		const credentials = await this.host.credentials();
		if (!credentials) {
			return "no_credentials";
		}
		let socket: ParlumeRealtimeSocket;
		try {
			socket = await this.host.connect(credentials);
		} catch {
			return "connect_failed";
		}
		if (this.status === "stopped") {
			socket.close(1000, "stopped");
			return "stopped";
		}
		const client: ParlumeRealtimeClient = new ParlumeRealtimeClient(
			socket,
			{
				onEvent: (event) => {
					if (this.client === client) {
						this.onEvent(event);
					}
				},
				onClose: (detail) => {
					if (this.client === client) {
						this.onClosed(detail);
					}
				},
			},
		);
		client.configure();
		const seeded = this.seed(client);
		const previous = this.client;
		this.client = client;
		previous?.close("replaced");
		if (previous) {
			this.settleReplaced();
		}
		this.vadSpeaking = false;
		this.connectedAt = this.host.now();
		this.rotation.start();
		this.host.log("info", "realtime.connected", {
			model: credentials.model,
			seeded,
		});
		return null;
	}

	/**
	 * A new session starts from what the meeting has said so far; false when
	 * nothing has been said yet.
	 */
	private seed(client: ParlumeRealtimeClient): boolean {
		const running = [...this.jobs.keys()];
		if (this.lines.length === 0 && running.length === 0) {
			return false;
		}
		client.addMessage(
			"system",
			[
				"This conversation continues from an earlier session of the same meeting.",
				running.length
					? `Fabric is still working on ${running.join(", ")}.`
					: null,
				this.lines.length
					? fence("meeting_so_far", "", this.lines.join("\n"))
					: null,
			]
				.filter(Boolean)
				.join("\n"),
		);
		return true;
	}

	/**
	 * A new session replaced one whose response had not ended: that response
	 * is resumed on the new one (`cutShort`), and nothing waits for the old
	 * one's audio any more, so `pump` never waits for a response that cannot
	 * end. What the outlet holds of it plays out.
	 */
	private settleReplaced(): void {
		this.cutShort("rotation");
		this.host.outlet()?.end();
		this.playing = false;
		this.audible = null;
		this.audioItem = null;
		this.playToken++;
	}

	/**
	 * Replaces the session as soon as its phase allows: from `quiet` when
	 * Parlume is neither answering nor audible, from `hold` once the response
	 * in progress is done, and at `force` at once.
	 */
	private rotateIfDue(): void {
		if (this.status !== "active" || this.rotating) {
			return;
		}
		const phase = this.rotation.current;
		switch (phase) {
			case "early":
				return;
			case "quiet":
				if (this.inFlight || this.playing || this.reading !== null) {
					return;
				}
				break;
			case "hold":
				if (this.inFlight) {
					return;
				}
				break;
			case "force":
				break;
			default: {
				const unreachable: never = phase;
				throw new Error(`Unknown rotation phase: ${unreachable}`);
			}
		}
		void this.rotate();
	}

	private async rotate(): Promise<void> {
		this.rotating = true;
		const failure = await this.connect();
		this.rotating = false;
		this.host.log(failure ? "warn" : "info", "realtime.reconnect", {
			reason: "session_limit",
			ok: failure === null,
			failure,
		});
		if (failure !== null && this.status === "active") {
			this.rotation.retryIn(ROTATE_RETRY_MS);
			return;
		}
		this.pump();
	}

	private onClosed(detail: string): void {
		this.client = null;
		// What the meeting was hearing is resumed on the next session.
		this.cutShort("dropped");
		// The dropped response sends no more audio; what was queued plays out.
		void this.endPlayback();
		this.settleQuiet();
		if (this.status !== "active") {
			return;
		}
		this.status = "reconnecting";
		const upMs = this.host.now() - this.connectedAt;
		this.host.log("warn", "realtime.dropped", { detail, upMs });
		// Only a session that held counts as recovered: one OpenAI closes as
		// soon as it opens would otherwise be reopened forever.
		if (upMs >= STABLE_SESSION_MS) {
			this.reconnectAttempts = 0;
		}
		this.scheduleReconnect();
	}

	private scheduleReconnect(): void {
		const attempt = this.reconnectAttempts++;
		const delay = RECONNECT_BACKOFF_MS[attempt];
		if (delay === undefined) {
			// No session will resume what was cut short: it goes to the chat.
			this.resumeMissed();
			this.stop("reconnect_failed");
			this.host.fallBack("reconnect_failed");
			return;
		}
		this.reconnectTimer = setTimeout(async () => {
			this.reconnectTimer = null;
			if (this.status !== "reconnecting") {
				return;
			}
			const failure = await this.connect();
			this.host.log(failure ? "warn" : "info", "realtime.reconnect", {
				reason: "dropped",
				attempt: attempt + 1,
				ok: failure === null,
				failure,
			});
			if (failure !== null) {
				this.scheduleReconnect();
				return;
			}
			if (this.status === "reconnecting") {
				this.status = "active";
				this.pump();
			}
		}, delay);
	}

	private clearTimers(): void {
		this.rotation.clear();
		for (const timer of [
			this.reconnectTimer,
			this.pauseTimer,
			this.resumeTimer,
		]) {
			if (timer) {
				clearTimeout(timer);
			}
		}
		this.reconnectTimer = null;
		this.pauseTimer = null;
		this.resumeTimer = null;
	}
}
