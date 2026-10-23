import type { ParlumeAuraOutlet } from "./parlume-aura";
import {
	PARLUME_REALTIME_SAMPLE_RATE,
	ParlumeRealtimeClient,
	type ParlumeRealtimeCredentials,
	type ParlumeRealtimeEvent,
	type ParlumeRealtimeFunctionCall,
	type ParlumeRealtimeSocket,
	type ParlumeRealtimeUsage,
} from "./parlume-realtime";
import { isRecord } from "./parlume-stream-auth";
import type { ParlumeRealtimeVoice } from "./parlume-voice-floor";

// OpenAI ends a Realtime session at 60 minutes; a fresh one takes over first,
// at a quiet moment when there is one.
const ROTATE_AFTER_MS = 55 * 60 * 1000;
const ROTATE_DEADLINE_MS = 59 * 60 * 1000;
const ROTATE_RETRY_MS = 5_000;
const RECONNECT_BACKOFF_MS = [1_000, 3_000, 10_000];
const MAX_SUMMARY_LINES = 40;
const MAX_LINE_CHARS = 400;
const MAX_REQUEST_CHARS = 2_000;
const MAX_CHAT_POST_CHARS = 3_900;
const MAX_RESULT_CHARS = 4_000;
const BYTES_PER_MS = (PARLUME_REALTIME_SAMPLE_RATE * 2) / 1000;
const USAGE_KEYS = [
	"inputTextTokens",
	"inputAudioTokens",
	"cachedTextTokens",
	"cachedAudioTokens",
	"outputTextTokens",
	"outputAudioTokens",
] as const satisfies ReadonlyArray<keyof ParlumeRealtimeUsage>;

type ParlumeRealtimeTool = "ask_fabric" | "post_to_chat" | "read_chat";

function parseTool(name: string): ParlumeRealtimeTool | null {
	return name === "ask_fabric" ||
		name === "post_to_chat" ||
		name === "read_chat"
		? name
		: null;
}

function parseArguments(text: string): Record<string, unknown> {
	try {
		const value: unknown = JSON.parse(text);
		return isRecord(value) ? value : {};
	} catch {
		return {};
	}
}

/** Text from elsewhere, inside a labelled block it cannot close early. */
function fence(tag: string, attributes: string, text: string): string {
	const body = text.replace(new RegExp(`<(/?)${tag}`, "gi"), `&lt;$1${tag}`);
	return `<${tag}${attributes}>\n${body}\n</${tag}>`;
}

export interface ParlumeFabricResult {
	job: string;
	status: "completed" | "failed";
	text: string;
	/** Posts the worker already made with the full result. */
	chatTags: string[];
}

/** The worker's `fabric-result` body. */
export function parseParlumeFabricResult(
	body: unknown,
): ParlumeFabricResult | null {
	if (!isRecord(body) || typeof body.job !== "string") {
		return null;
	}
	const status = body.status;
	const text =
		typeof body.text === "string"
			? body.text.slice(0, MAX_RESULT_CHARS)
			: "";
	if (
		!/^J\d{1,6}$/.test(body.job) ||
		(status !== "completed" && status !== "failed") ||
		(status === "completed" && !text.trim())
	) {
		return null;
	}
	const chatTags = Array.isArray(body.chatTags)
		? body.chatTags
				.filter(
					(tag): tag is string =>
						typeof tag === "string" && /^P\d{1,6}$/.test(tag),
				)
				.slice(0, 10)
		: [];
	return { job: body.job, status, text, chatTags };
}

type ParlumeRealtimeChatResult =
	| { posted: true; tag: string }
	| { posted: false; reason: string };

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
	/** Hands a request to Fabric as a meeting turn; false when Fabric refused it. */
	dispatchJob(input: {
		job: string;
		request: string;
		requester: string | null;
		generation: number;
	}): Promise<boolean>;
	postChat(text: string): Promise<ParlumeRealtimeChatResult>;
	readChat(): Array<{ from: string | null; text: string }>;
	reportUsage(usage: ParlumeRealtimeUsage): void;
	/** Realtime is gone for good: the meeting carries on with the classic engine. */
	fallBack(reason: string): void;
	log(
		level: "info" | "warn" | "error",
		event: string,
		meta: Record<string, unknown>,
	): void;
	now(): number;
}

type ResponseKind = "wake" | "chat" | "say" | "tool" | "result";

type ConversationItem =
	| { role: "system" | "user"; text: string }
	| { callId: string; output: object };

interface QueuedResponse {
	kind: ResponseKind;
	items: ConversationItem[];
	/** What the response latency is measured from. */
	since: number;
	resolve: (spoken: boolean) => void;
}

interface ResponseInFlight {
	id: string | null;
	kind: ResponseKind;
	since: number;
	heard: boolean;
	cancelled: boolean;
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
	private playToken = 0;
	private armed: { requester: string | null; speakerKey: string } | null =
		null;
	/** The speaker last answered, until anyone speaks again. */
	private answered: string | null = null;
	private speechSinceAnswer = false;
	private vadSpeaking = false;
	private lastRequester: string | null = null;
	private jobs = new Map<string, { generation: number }>();
	private jobCounter = 0;
	private lines: string[] = [];
	private connectedAt = 0;
	private reconnectAttempts = 0;
	private rotateTimer: ReturnType<typeof setTimeout> | null = null;
	private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
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

	async start(): Promise<{ ok: true } | { ok: false; reason: string }> {
		const failure = await this.connect(false);
		if (failure !== null) {
			this.status = "stopped";
			return { ok: false, reason: failure };
		}
		this.status = "active";
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
		this.inFlight?.resolve(false);
		this.inFlight = null;
		for (const queued of this.queue.splice(0)) {
			queued.resolve(false);
		}
		this.jobs.clear();
		this.host.log("info", "realtime.closed", { reason, ...this.totals });
	}

	appendAudio(pcm: Uint8Array, sampleRate: number): void {
		if (this.client?.isOpen) {
			this.client.appendAudio(pcm, sampleRate);
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
	}

	/**
	 * Someone addressed Parlume. A wake phrase heard mid-utterance waits for
	 * the speaker to stop; one in a finished utterance is answered at once,
	 * unless that utterance was already answered.
	 */
	arm(input: {
		requester: string | null;
		speakerKey: string;
		endOfTurn: boolean;
	}): void {
		if (!this.active) {
			return;
		}
		if (
			input.endOfTurn &&
			this.answered === input.speakerKey &&
			!this.speechSinceAnswer
		) {
			return;
		}
		this.armed = {
			requester: input.requester,
			speakerKey: input.speakerKey,
		};
		if (input.endOfTurn) {
			this.answerArmed();
		}
	}

	/** A chat message that asked to be answered aloud. */
	respondToChat(speaker: string | null, text: string): Promise<boolean> {
		this.lastRequester = speaker;
		return this.respond("chat", [
			{
				role: "user",
				text: `${speaker ?? "A participant"} asked in the meeting chat for a spoken answer:\n${fence("chat_message", "", text)}`,
			},
		]);
	}

	/** Reads a chat post aloud, in Parlume's realtime voice. */
	say(text: string): Promise<boolean> {
		return this.respond("say", [
			{
				role: "system",
				text: `Read this meeting chat post aloud, as written:\n${fence("chat_post", "", text)}`,
			},
		]);
	}

	/** A Fabric job's outcome, spoken once nothing else is being said. */
	deliverResult(input: ParlumeFabricResult): boolean {
		if (!this.active || !this.jobs.has(input.job)) {
			return false;
		}
		this.jobs.delete(input.job);
		this.host.log("info", "realtime.job_result", {
			job: input.job,
			status: input.status,
			chars: input.text.length,
			chatPosts: input.chatTags.length,
		});
		const inChat = input.chatTags.length
			? ` It is also in the meeting chat as ${input.chatTags.join(", ")}.`
			: "";
		void this.respond("result", [
			{
				role: "system",
				text:
					input.status === "completed"
						? `Fabric finished ${input.job}.${inChat}\n${fence("fabric_result", ` job="${input.job}"`, input.text.slice(0, MAX_RESULT_CHARS))}`
						: `Fabric could not finish ${input.job}.`,
			},
		]);
		return true;
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

	hasJob(generation: number): boolean {
		return [...this.jobs.values()].some(
			(job) => job.generation === generation,
		);
	}

	silence(kind: "mute" | "cancel", droppedBytes: number): void {
		const client = this.client;
		this.playing = false;
		this.playToken++;
		const inFlight = this.inFlight;
		if (inFlight && !inFlight.cancelled) {
			inFlight.cancelled = true;
			client?.cancelResponse(inFlight.id);
		}
		const item = this.audioItem;
		this.audioItem = null;
		if (item && client) {
			const playedMs = Math.floor(
				Math.max(0, item.bytes - droppedBytes) / BYTES_PER_MS,
			);
			client.truncate(item.itemId, playedMs);
			this.host.log("info", "realtime.truncated", {
				kind,
				playedMs,
				droppedMs: Math.round(droppedBytes / BYTES_PER_MS),
			});
		}
		if (kind === "cancel") {
			this.armed = null;
			for (const queued of this.queue.splice(0)) {
				queued.resolve(false);
			}
			this.jobs.clear();
		}
	}

	private answerArmed(): void {
		const armed = this.armed;
		if (!armed) {
			return;
		}
		this.armed = null;
		this.answered = armed.speakerKey;
		this.speechSinceAnswer = false;
		this.lastRequester = armed.requester;
		// Flux heard the end of the request before OpenAI's turn detection did:
		// the request's audio becomes a turn of its own now.
		if (this.vadSpeaking) {
			this.client?.commitAudio();
		}
		void this.respond("wake", [
			{
				role: "system",
				text: `${armed.requester ?? "A participant"} just addressed you. Answer them now.`,
			},
		]);
	}

	private respond(
		kind: ResponseKind,
		items: ConversationItem[],
	): Promise<boolean> {
		if (!this.active) {
			return Promise.resolve(false);
		}
		return new Promise((resolve) => {
			this.queue.push({ kind, items, since: this.host.now(), resolve });
			this.pump();
		});
	}

	/**
	 * Starts the next queued response once the last one is done. Only one
	 * response writes to the conversation at a time; anything but an answer
	 * to a request also waits for whoever is talking to finish.
	 */
	private pump(): void {
		const client = this.client;
		const next = this.queue[0];
		if (
			!next ||
			!client?.isOpen ||
			this.status !== "active" ||
			this.inFlight ||
			(this.vadSpeaking && next.kind !== "wake")
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
			heard: false,
			cancelled: false,
			resolve: next.resolve,
		};
	}

	private onEvent(event: ParlumeRealtimeEvent): void {
		switch (event.type) {
			case "speech_started":
				this.vadSpeaking = true;
				this.speechSinceAnswer = true;
				return;
			case "speech_stopped":
				this.vadSpeaking = false;
				this.answerArmed();
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
				this.host.log("warn", "realtime.error", { code: event.code });
				// A response the server refused to create never reports done.
				if (this.inFlight && this.inFlight.id === null) {
					this.inFlight.resolve(false);
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

	private play(event: {
		responseId: string;
		itemId: string;
		audio: Uint8Array;
	}) {
		const inFlight = this.inFlight;
		if (
			!inFlight ||
			inFlight.cancelled ||
			(inFlight.id !== null && inFlight.id !== event.responseId)
		) {
			return;
		}
		const outlet = this.host.outlet();
		if (!outlet) {
			return;
		}
		if (!inFlight.heard) {
			inFlight.heard = true;
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
		this.playToken++;
	}

	private finish(event: {
		responseId: string;
		status: string;
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
		for (const transcript of event.transcripts) {
			this.noteLine("Parlume", transcript);
		}
		const inFlight = this.inFlight;
		if (
			!inFlight ||
			(inFlight.id !== null && inFlight.id !== event.responseId)
		) {
			return;
		}
		this.inFlight = null;
		const completed = event.status === "completed" && !inFlight.cancelled;
		const outlet = this.host.outlet();
		if (this.playing && outlet) {
			outlet.end();
			const token = this.playToken;
			void outlet.drained().then(() => {
				if (token === this.playToken) {
					this.playing = false;
					this.audioItem = null;
				}
			});
		}
		inFlight.resolve(completed);
		if (completed && event.functionCalls.length > 0) {
			void this.answerCalls(event.functionCalls);
		}
		this.pump();
	}

	private async answerCalls(calls: ParlumeRealtimeFunctionCall[]) {
		const items: ConversationItem[] = [];
		for (const call of calls) {
			items.push({
				callId: call.callId,
				output: await this.runTool(call),
			});
		}
		void this.respond("tool", items);
	}

	private async runTool(call: ParlumeRealtimeFunctionCall): Promise<object> {
		const tool = parseTool(call.name);
		const args = parseArguments(call.arguments);
		if (tool === null) {
			return { error: "unknown_tool" };
		}
		switch (tool) {
			case "ask_fabric":
				return this.askFabric(args);
			case "post_to_chat": {
				const text =
					typeof args.text === "string"
						? args.text.trim().slice(0, MAX_CHAT_POST_CHARS)
						: "";
				return text
					? this.host.postChat(text)
					: { posted: false, reason: "empty" };
			}
			case "read_chat":
				return { messages: this.host.readChat() };
			default: {
				const unreachable: never = tool;
				return unreachable;
			}
		}
	}

	/**
	 * Starts a Fabric turn and answers at once, so the conversation goes on
	 * while Fabric works; the result comes back through `deliverResult`.
	 */
	private askFabric(args: Record<string, unknown>): object {
		const request =
			typeof args.request === "string"
				? args.request.trim().slice(0, MAX_REQUEST_CHARS)
				: "";
		if (!request) {
			return { status: "invalid", error: "request is required" };
		}
		if (this.jobs.size > 0) {
			return { status: "busy", running: [...this.jobs.keys()] };
		}
		const job = `J${++this.jobCounter}`;
		const generation = this.host.generation();
		this.jobs.set(job, { generation });
		this.host.log("info", "realtime.job_started", {
			job,
			voiceGeneration: generation,
			requestChars: request.length,
		});
		void this.host
			.dispatchJob({
				job,
				request,
				requester: this.lastRequester,
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
		return { status: "started", job };
	}

	/** Opens a session; returns why it could not, or null once it is live. */
	private async connect(seed: boolean): Promise<string | null> {
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
		if (seed) {
			this.seed(client);
		}
		const previous = this.client;
		this.client = client;
		previous?.close("replaced");
		this.vadSpeaking = false;
		this.connectedAt = this.host.now();
		this.scheduleRotation(ROTATE_AFTER_MS);
		this.host.log("info", "realtime.connected", {
			model: credentials.model,
			seeded: seed,
		});
		return null;
	}

	/** A new session starts from what the meeting has said so far. */
	private seed(client: ParlumeRealtimeClient): void {
		const running = [...this.jobs.keys()];
		if (this.lines.length === 0 && running.length === 0) {
			return;
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
	}

	private scheduleRotation(delayMs: number): void {
		if (this.rotateTimer) {
			clearTimeout(this.rotateTimer);
		}
		this.rotateTimer = setTimeout(() => void this.rotate(), delayMs);
	}

	private async rotate(): Promise<void> {
		this.rotateTimer = null;
		if (this.status !== "active") {
			return;
		}
		const age = this.host.now() - this.connectedAt;
		if ((this.inFlight || this.playing) && age < ROTATE_DEADLINE_MS) {
			this.scheduleRotation(ROTATE_RETRY_MS);
			return;
		}
		const failure = await this.connect(true);
		this.host.log(failure ? "warn" : "info", "realtime.reconnect", {
			reason: "session_limit",
			ok: failure === null,
			failure,
		});
		if (failure !== null && this.status === "active") {
			this.scheduleRotation(ROTATE_RETRY_MS);
		}
		this.pump();
	}

	private onClosed(detail: string): void {
		this.client = null;
		this.inFlight?.resolve(false);
		this.inFlight = null;
		if (this.status !== "active") {
			return;
		}
		this.status = "reconnecting";
		this.host.log("warn", "realtime.dropped", { detail });
		this.scheduleReconnect();
	}

	private scheduleReconnect(): void {
		const attempt = this.reconnectAttempts++;
		const delay = RECONNECT_BACKOFF_MS[attempt];
		if (delay === undefined) {
			this.stop("reconnect_failed");
			this.host.fallBack("reconnect_failed");
			return;
		}
		this.reconnectTimer = setTimeout(async () => {
			this.reconnectTimer = null;
			if (this.status !== "reconnecting") {
				return;
			}
			const failure = await this.connect(true);
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
				this.reconnectAttempts = 0;
				this.pump();
			}
		}, delay);
	}

	private clearTimers(): void {
		for (const timer of [this.rotateTimer, this.reconnectTimer]) {
			if (timer) {
				clearTimeout(timer);
			}
		}
		this.rotateTimer = null;
		this.reconnectTimer = null;
	}
}
