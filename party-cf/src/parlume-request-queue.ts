import { ParlumeReadChapters } from "./parlume-chat";
import { type ParlumeStopActor, parlumeFirstName } from "./parlume-stop";

/** The bridge's key for a speaker the meeting could not name. */
export const UNKNOWN_SPEAKER = "unknown";

const QUEUE_KEY = "requestQueue";
/** The most requests that wait behind the answer Parlume is giving. */
const PARLUME_QUEUE_MAX = 5;
/** A request that waited this long is no longer answered. */
const PARLUME_QUEUE_TTL_MS = 2 * 60 * 1000;
/** How long a request whose turn has come waits for the meeting to pause. */
const PARLUME_PAUSE_WAIT_MS = 1_500;
/** After a stop, the next request waits for this long with no speech. */
const PARLUME_QUIET_AFTER_STOP_MS = 2_000;

/** One key per person, for a request heard aloud or typed in the chat. */
export function parlumeSpeakerKey(
	speakerId: string | null,
	speakerName: string | null,
): string {
	return speakerId ?? speakerName?.toLowerCase() ?? UNKNOWN_SPEAKER;
}

/** What waits for Parlume: a request for Fabric, or text to read aloud. */
type ParlumeFloorRequest<T> =
	| { kind: "turn"; turn: T }
	| { kind: "read"; text: string; chapter: boolean };

interface ParlumeQueuedRequest<T> {
	request: ParlumeFloorRequest<T>;
	/** Who asked; null when the meeting could not name them. */
	askerKey: string | null;
	askerName: string | null;
	queuedAt: number;
}

interface StoredQueue<T> {
	entries: ParlumeQueuedRequest<T>[];
	/** The answer before was stopped: the next waits for a quiet moment. */
	quietAfterStop: boolean;
}

interface ParlumeRequestQueueHost<T> {
	storage: Pick<DurableObjectStorage, "get" | "put">;
	/** Parlume is saying, reading or answering something, in either voice. */
	busy(): boolean;
	/**
	 * Resolves once the realtime voice gives up the floor it holds; null when
	 * it holds none.
	 */
	whenVoiceQuiet(): Promise<void> | null;
	maySpeak(): boolean;
	/** Starts a request's turn; it resolves once Parlume is busy with it. */
	startTurn(turn: T): Promise<void>;
	/** Reads text aloud as it is, for `asker`; Parlume is busy at once. */
	read(text: string, asker: string | null): Promise<boolean>;
	/** One line in the meeting chat. */
	postNotice(text: string): Promise<unknown>;
	log(
		level: "info" | "warn" | "error",
		event: string,
		meta: Record<string, unknown>,
	): void;
	now(): number;
}

function who(name: string | null): string {
	return parlumeFirstName(name) ?? "Someone";
}

/** The one line a request that could not wait gets in the meeting chat. */
function notQueuedNotice(
	name: string | null,
	reason: "full" | "duplicate",
): string {
	const why =
		reason === "full"
			? `${PARLUME_QUEUE_MAX} requests are already waiting`
			: "you already have a request waiting";
	return `**Not queued** · ${who(name)}, ${why}. Ask me again after the current answer.`;
}

/** The one line a request that waited too long gets. */
function expiredNotice(name: string | null): string {
	return `**Not answered** · ${who(name)}, your request waited more than two minutes. Ask me again.`;
}

/** The sentences of an answer, the first opening with its asker's name. */
export async function* parlumeGreeted(
	name: string,
	sentences: AsyncIterable<string>,
): AsyncGenerator<string> {
	let first = true;
	for await (const sentence of sentences) {
		yield first ? `${name}, ${sentence}` : sentence;
		first = false;
	}
}

/**
 * What arrives while Parlume speaks or prepares an answer, a spoken or typed
 * request or a post to read aloud, answered one after another in the order
 * it came, each once the answer before it has ended, and opening with its
 * asker's name. At most `PARLUME_QUEUE_MAX` wait, one per person, each for
 * at most `PARLUME_QUEUE_TTL_MS`. The queue lives in Durable Object storage,
 * so a restart keeps it.
 *
 * A request whose turn has come waits up to `PARLUME_PAUSE_WAIT_MS` for the
 * meeting to pause, and so does any read. After a stop only the answer that
 * was stopped ends: the next starts once nobody has spoken for
 * `PARLUME_QUIET_AFTER_STOP_MS`. A pause or a closed speech gate drops all
 * that waits. A long post is read in chapters (`ParlumeReadChapters`).
 */
export class ParlumeRequestQueue<T> {
	private entries: ParlumeQueuedRequest<T>[] = [];
	private quietAfterStop = false;
	// Participant speech, as transcripts report it: when it was last heard,
	// and whether a turn is still being said.
	private heardAt = Number.NEGATIVE_INFINITY;
	private speechOpen = false;
	private stoppedAt = Number.NEGATIVE_INFINITY;
	// When Parlume became free with a request waiting.
	private freeSince: number | null = null;
	private starting = false;
	private waitingForVoice = false;
	private timer: ReturnType<typeof setTimeout> | null = null;
	private pauseWaiters: Array<() => void> = [];
	private readonly chapters: ParlumeReadChapters;

	constructor(private readonly host: ParlumeRequestQueueHost<T>) {
		this.chapters = new ParlumeReadChapters(() => host.now());
	}

	async load(): Promise<void> {
		const stored = await this.host.storage.get<StoredQueue<T>>(QUEUE_KEY);
		this.entries = stored?.entries ?? [];
		this.quietAfterStop = stored?.quietAfterStop ?? false;
	}

	/** A new request waits its turn: Parlume is busy, or others wait. */
	get mustWait(): boolean {
		return this.entries.length > 0 || this.host.busy();
	}

	/** A chapter of a post read aloud waits to be asked for. */
	get chapterWaiting(): boolean {
		return this.chapters.waiting;
	}

	/** A request that waits for the answer in progress; false if it cannot. */
	turn(turn: T, asker: ParlumeStopActor | null): Promise<boolean> {
		return this.add({ kind: "turn", turn }, asker);
	}

	/**
	 * Reads a post aloud, its first chapter if it is long: at once when
	 * Parlume is free, otherwise after what it is saying. False unless it was
	 * read to its end now. Text with no asker, such as a notice, never waits
	 * in the queue.
	 */
	async read(text: string, asker: ParlumeStopActor | null): Promise<boolean> {
		if (asker && this.mustWait) {
			await this.add({ kind: "read", text, chapter: false }, asker);
			return false;
		}
		return this.readNow(text, false, asker?.name ?? null, false);
	}

	/**
	 * Text a member asked for on the Parlume page: read at once when Parlume
	 * is free, otherwise after what waits. False when Parlume may not speak,
	 * or the queue cannot take it.
	 */
	async offer(text: string, asker: ParlumeStopActor): Promise<boolean> {
		if (!this.host.maySpeak()) {
			return false;
		}
		if (this.mustWait) {
			return this.add({ kind: "read", text, chapter: false }, asker);
		}
		void this.readNow(text, false, asker.name, false);
		return true;
	}

	/** "Continue": the next chapter is read; false when none waits. */
	async continueReading(actor: ParlumeStopActor | null): Promise<boolean> {
		const chapter = this.host.maySpeak() ? this.chapters.next() : null;
		if (chapter === null) {
			return false;
		}
		if (actor && this.mustWait) {
			return this.add(
				{ kind: "read", text: chapter, chapter: true },
				actor,
			);
		}
		void this.readNow(chapter, true, actor?.name ?? null, false);
		return true;
	}

	/** A participant was heard; `open` while their turn is still being said. */
	noteHeard(open: boolean): void {
		this.heardAt = this.host.now();
		this.speechOpen = open;
		if (!open) {
			for (const resolve of this.pauseWaiters.splice(0)) {
				resolve();
			}
		}
		if (this.entries.length > 0) {
			this.pump();
		}
	}

	/** Resolves when the meeting pauses, or after `PARLUME_PAUSE_WAIT_MS`. */
	waitForPause(): Promise<void> {
		if (!this.speechOpen) {
			return Promise.resolve();
		}
		return new Promise((resolve) => {
			this.pauseWaiters.push(resolve);
			setTimeout(resolve, PARLUME_PAUSE_WAIT_MS);
		});
	}

	/** Someone stopped the answer: what waits stays, for a quiet moment. */
	async afterStop(): Promise<void> {
		this.stoppedAt = this.host.now();
		if (this.entries.length === 0) {
			return;
		}
		this.quietAfterStop = true;
		await this.save();
		this.pump();
	}

	/** A pause or a closed speech gate: nothing that waits is answered. */
	async clear(): Promise<void> {
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = null;
		}
		if (this.entries.length === 0 && !this.quietAfterStop) {
			return;
		}
		this.host.log("info", "queue.cleared", {
			dropped: this.entries.length,
		});
		this.entries = [];
		this.quietAfterStop = false;
		this.freeSince = null;
		await this.save();
	}

	/** Starts the next request, once Parlume is free and the meeting allows. */
	pump(): void {
		if (this.starting || this.entries.length === 0) {
			return;
		}
		if (this.host.busy()) {
			this.freeSince = null;
			this.pumpWhenVoiceQuiet();
			return;
		}
		const now = this.host.now();
		this.freeSince ??= now;
		const waitMs = this.waitMs(now, this.freeSince);
		if (waitMs > 0) {
			if (this.timer) {
				clearTimeout(this.timer);
			}
			this.timer = setTimeout(() => {
				this.timer = null;
				this.pump();
			}, waitMs);
			return;
		}
		this.starting = true;
		void this.startNext().finally(() => {
			this.starting = false;
			this.pump();
		});
	}

	/**
	 * Queues a request; false when it cannot wait, and its asker is told so
	 * in the chat. A person the meeting could not name may queue more than one.
	 */
	private async add(
		request: ParlumeFloorRequest<T>,
		asker: ParlumeStopActor | null,
	): Promise<boolean> {
		const askerName = asker?.name ?? null;
		const askerKey = asker ? parlumeSpeakerKey(asker.id, askerName) : null;
		const named = askerKey !== null && askerKey !== UNKNOWN_SPEAKER;
		const duplicate =
			named && this.entries.some((entry) => entry.askerKey === askerKey);
		const refused =
			this.entries.length >= PARLUME_QUEUE_MAX
				? "full"
				: duplicate
					? "duplicate"
					: null;
		if (refused) {
			this.host.log("info", "queue.refused", {
				reason: refused,
				kind: request.kind,
				waiting: this.entries.length,
			});
			await this.host.postNotice(notQueuedNotice(askerName, refused));
			return false;
		}
		this.entries.push({
			request,
			askerKey: named ? askerKey : null,
			askerName,
			queuedAt: this.host.now(),
		});
		await this.save();
		this.host.log("info", "queue.added", {
			kind: request.kind,
			waiting: this.entries.length,
		});
		this.pump();
		return true;
	}

	/**
	 * The classic voice pumps the queue when its speech ends; the realtime
	 * voice is waited for here.
	 */
	private pumpWhenVoiceQuiet(): void {
		const quiet = this.waitingForVoice ? null : this.host.whenVoiceQuiet();
		if (quiet) {
			this.waitingForVoice = true;
			void quiet.then(() => {
				this.waitingForVoice = false;
				this.pump();
			});
		}
	}

	/** How long the next request still waits for the meeting. */
	private waitMs(now: number, freeSince: number): number {
		if (this.quietAfterStop) {
			const quietSince = Math.max(this.heardAt, this.stoppedAt);
			return quietSince + PARLUME_QUIET_AFTER_STOP_MS - now;
		}
		return this.speechOpen ? freeSince + PARLUME_PAUSE_WAIT_MS - now : 0;
	}

	private async startNext(): Promise<void> {
		const now = this.host.now();
		const expired = this.entries.filter(
			(entry) => now - entry.queuedAt >= PARLUME_QUEUE_TTL_MS,
		);
		this.entries = this.entries.filter(
			(entry) => now - entry.queuedAt < PARLUME_QUEUE_TTL_MS,
		);
		const next = this.entries.shift();
		this.quietAfterStop = false;
		this.freeSince = null;
		await this.save();
		if (next) {
			this.host.log("info", "queue.started", {
				kind: next.request.kind,
				waitedMs: now - next.queuedAt,
				waiting: this.entries.length,
			});
			await this.start(next);
		}
		for (const entry of expired) {
			this.host.log("info", "queue.expired", {
				kind: entry.request.kind,
				waitedMs: now - entry.queuedAt,
			});
			await this.host.postNotice(expiredNotice(entry.askerName));
		}
	}

	private async start(entry: ParlumeQueuedRequest<T>): Promise<void> {
		const { request } = entry;
		switch (request.kind) {
			case "turn":
				await this.host.startTurn(request.turn);
				return;
			case "read":
				void this.readNow(
					request.text,
					request.chapter,
					entry.askerName,
					true,
				);
				return;
			default: {
				const unreachable: never = request;
				return unreachable;
			}
		}
	}

	/** A read, or a chapter of one, said now; `greet` names its asker first. */
	private readNow(
		text: string,
		chapter: boolean,
		asker: string | null,
		greet: boolean,
	): Promise<boolean> {
		if (!this.host.maySpeak()) {
			return Promise.resolve(false);
		}
		const spoken = chapter ? text : this.chapters.begin(text);
		const name = greet ? parlumeFirstName(asker) : null;
		return this.host.read(name ? `${name}, ${spoken}` : spoken, asker);
	}

	private save(): Promise<void> {
		return this.host.storage.put<StoredQueue<T>>(QUEUE_KEY, {
			entries: this.entries,
			quietAfterStop: this.quietAfterStop,
		});
	}
}
