// Parlume's voice. The bridge synthesizes each sentence on Workers AI with
// Deepgram Aura-2 and feeds the audio outlet directly, so the reply never makes
// the trip through the worker: the request and the audio both stay on
// Cloudflare. The worker keeps its own synthesis routes as a fallback.

const PARLUME_AURA_MODEL = "@cf/deepgram/aura-2-en";
const AURA_SPEAKER = "orpheus";
// Fabric's speech rate: the outlet and the bot are created at the same rate.
const AURA_SAMPLE_RATE = 24_000;
const MAX_CLIP_BYTES = 6 * 1024 * 1024;
const MAX_SENTENCES = 40;
const MAX_SENTENCE_CHARS = 2_000;
const MAX_TOTAL_CHARS = 8_000;
// How long a reply sent in parts waits for its next one before it ends with
// what it has; the worker gives up on the whole reply after 90 seconds.
const PART_IDLE_MS = 60_000;
// A sentence Aura has not started answering within this long fails, like an
// error from Aura: a call that never answered held the voice for good.
const CLIP_START_MS = 10_000;
// A sentence that failed is asked for once more after this long, before the
// worker's own routes, in another voice, take over.
const RETRY_MS = 300;

export interface ParlumeAuraBinding {
	run(
		model: typeof PARLUME_AURA_MODEL,
		inputs: {
			text: string;
			speaker: typeof AURA_SPEAKER;
			encoding: "linear16";
			container: "none";
			sample_rate: number;
		},
		options: { returnRawResponse: true },
	): Promise<Response>;
}

export interface ParlumeAuraOutlet {
	enqueue(bytes: Uint8Array): void;
	end(): void;
	clear(): void;
	drained(): Promise<void>;
	/** Bytes ever dropped by `clear` before they were sent: speech nobody heard. */
	readonly droppedBytes: number;
}

/** What one sentence cost; times are milliseconds. */
interface ParlumeAuraSentence {
	chars: number;
	/** When synthesis began, after the speech request arrived. */
	startedAtMs: number;
	/** From that start to the first audio byte. */
	firstByteMs: number | null;
	/** From that start to the last audio byte. */
	totalMs: number | null;
	/** Audio for this sentence reached the outlet. */
	ok: boolean;
}

/** A sentence Aura was asked for again after it failed. */
export interface ParlumeAuraRetry {
	sentence: number;
	/** Part of it was queued before it failed: it played again in full. */
	replayed: boolean;
	/** The second attempt played it. */
	played: boolean;
}

/** `onRetry` that logs each retry as `aura.retry`, ids and numbers only. */
export function parlumeAuraRetryLog(
	log: (
		level: "info" | "warn",
		event: string,
		meta: Record<string, unknown>,
	) => void,
	meta: Record<string, unknown>,
): (retry: ParlumeAuraRetry) => void {
	return (retry) =>
		log(retry.played ? "info" : "warn", "aura.retry", {
			...meta,
			...retry,
		});
}

export interface ParlumeAuraPlayback {
	/** Every sentence was synthesized and played while the reply was current. */
	complete: boolean;
	/**
	 * The sentence that failed twice, when synthesis failed. Sentences before
	 * it were played; the caller may speak the rest itself, from this one's
	 * start even when part of it was heard.
	 */
	failedAt?: number;
	error?: string;
	firstAudioAt?: number;
	/**
	 * How many sentences, from the first, were heard to their end. Speech the
	 * outlet dropped when the reply was silenced counts as unheard, and so
	 * does the sentence it cut into.
	 */
	heard: number;
	sentences: ParlumeAuraSentence[];
}

/**
 * Reads newline-delimited `{"text": "..."}` lines from a request body, one
 * sentence per line, as they arrive.
 */
export async function* readParlumeSentenceLines(
	body: ReadableStream<Uint8Array>,
): AsyncGenerator<string> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	let count = 0;
	let chars = 0;
	const parse = (line: string): string | null => {
		if (!line.trim()) {
			return null;
		}
		const value: unknown = JSON.parse(line);
		const text =
			typeof value === "object" &&
			value !== null &&
			"text" in value &&
			typeof value.text === "string"
				? value.text.trim()
				: "";
		if (!text || text.length > MAX_SENTENCE_CHARS) {
			throw new Error("Invalid sentence");
		}
		count++;
		chars += text.length;
		if (count > MAX_SENTENCES || chars > MAX_TOTAL_CHARS) {
			throw new Error("Too much text");
		}
		return text;
	};
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (value) {
				buffer += decoder.decode(value, { stream: true });
			}
			if (done) {
				buffer += decoder.decode();
			}
			let newline = buffer.indexOf("\n");
			while (newline >= 0) {
				const text = parse(buffer.slice(0, newline));
				buffer = buffer.slice(newline + 1);
				if (text !== null) {
					yield text;
				}
				newline = buffer.indexOf("\n");
			}
			if (buffer.length > MAX_SENTENCE_CHARS * 6) {
				throw new Error("Invalid sentence");
			}
			if (done) {
				const text = parse(buffer);
				if (text !== null) {
					yield text;
				}
				return;
			}
		}
	} finally {
		await reader.cancel().catch(() => {});
		reader.releaseLock();
	}
}

/**
 * A reply's sentences sent as numbered parts, one request each, released in
 * part order however the requests arrive. The edge holds a request body until
 * it ends, so a reply spoken while the agent is still writing it cannot be one
 * streamed body: each sentence comes as a part as soon as it exists. Ends
 * after the part marked last, on `close`, or when no part arrives for
 * `idleMs`; `fail` ends it with an error.
 */
export class ParlumeSentenceFeed implements AsyncIterable<string> {
	private readonly parts = new Map<
		number,
		{ sentences: string[]; last: boolean }
	>();
	private nextPart = 0;
	private readonly ready: string[] = [];
	private count = 0;
	private chars = 0;
	private ended = false;
	private failure: Error | null = null;
	private waiter: (() => void) | null = null;
	private readonly idleMs: number;

	constructor(idleMs = PART_IDLE_MS) {
		this.idleMs = idleMs;
	}

	/** The reply takes no more parts. */
	get closed(): boolean {
		return this.ended || this.failure !== null;
	}

	/** The reply was withdrawn, or a part of it was refused. */
	get failed(): boolean {
		return this.failure !== null;
	}

	/** False when the reply takes no more parts or already has this one. */
	add(part: number, sentences: string[], last: boolean): boolean {
		if (this.closed || part < this.nextPart || this.parts.has(part)) {
			return false;
		}
		this.parts.set(part, { sentences, last });
		for (
			let next = this.parts.get(this.nextPart);
			next && !this.closed;
			next = this.parts.get(this.nextPart)
		) {
			this.parts.delete(this.nextPart);
			this.nextPart++;
			for (const sentence of next.sentences) {
				this.count++;
				this.chars += sentence.length;
				if (
					this.count > MAX_SENTENCES ||
					this.chars > MAX_TOTAL_CHARS
				) {
					this.fail(new Error("Too much text"));
					return true;
				}
				this.ready.push(sentence);
			}
			this.ended = next.last;
		}
		this.wake();
		return true;
	}

	close(): void {
		this.ended = true;
		this.wake();
	}

	fail(error: Error): void {
		this.failure ??= error;
		this.wake();
	}

	async *[Symbol.asyncIterator](): AsyncIterator<string> {
		for (;;) {
			if (this.failure) {
				throw this.failure;
			}
			const sentence = this.ready.shift();
			if (sentence !== undefined) {
				yield sentence;
				continue;
			}
			if (this.ended) {
				return;
			}
			const arrived = await new Promise<boolean>((resolve) => {
				const timer = setTimeout(() => resolve(false), this.idleMs);
				this.waiter = () => {
					clearTimeout(timer);
					resolve(true);
				};
			});
			if (!arrived) {
				this.close();
			}
		}
	}

	private wake(): void {
		const waiter = this.waiter;
		this.waiter = null;
		waiter?.();
	}
}

/** The sentences of one reply part, whose request body holds all of them. */
async function readParlumeSentencePart(
	body: ReadableStream<Uint8Array> | null,
): Promise<string[]> {
	const sentences: string[] = [];
	if (body) {
		for await (const sentence of readParlumeSentenceLines(body)) {
			sentences.push(sentence);
		}
	}
	return sentences;
}

/**
 * The latest reply sent in parts, kept after it ends so that a part
 * arriving late is refused rather than starting a reply of its own.
 */
export class ParlumeReplyParts {
	private reply: {
		id: string;
		feed: ParlumeSentenceFeed;
		heard: number;
	} | null = null;

	/** The feed of the reply sent in parts; a new reply ends the one before. */
	feed(replyId: string): ParlumeSentenceFeed {
		if (this.reply?.id !== replyId) {
			this.reply?.feed.close();
			this.reply = {
				id: replyId,
				feed: new ParlumeSentenceFeed(),
				heard: 0,
			};
		}
		return this.reply.feed;
	}

	/** How many of the reply's sentences, from the first, were heard so far. */
	noteHeard(replyId: string, heard: number): void {
		if (this.reply?.id === replyId) {
			this.reply.heard = Math.max(this.reply.heard, heard);
		}
	}

	private heard(replyId: string): number {
		return this.reply?.id === replyId ? this.reply.heard : 0;
	}

	/** Ends the reply in progress, whatever its id. */
	close(): void {
		this.reply?.feed.close();
	}

	/**
	 * Refuses the reply's later parts. A reply still being played under
	 * another id is left alone: a stale part must not end it.
	 */
	end(replyId: string): void {
		if (
			!this.reply ||
			this.reply.id === replyId ||
			this.reply.feed.closed
		) {
			this.feed(replyId).close();
		}
	}

	/**
	 * A later part of a reply sent in parts. It may arrive before the part
	 * that starts the reply, and is kept for it; a part for a generation that
	 * was replaced (`current` false), or for a reply already played, is
	 * refused. `x-parlume-reply-cancel` withdraws the reply: what is queued
	 * is dropped. Each answer says how many of the reply's sentences were
	 * heard so far, so a worker that lost the answer to the first part goes
	 * on from there.
	 */
	async add(
		request: Request,
		replyId: string,
		part: number,
		current: boolean,
	): Promise<Response> {
		if (!current) {
			this.end(replyId);
			return Response.json({
				accepted: false,
				heard: this.heard(replyId),
			});
		}
		const feed = this.feed(replyId);
		if (request.headers.get("x-parlume-reply-cancel") === "1") {
			feed.fail(new Error("The reply was withdrawn"));
			return Response.json({
				accepted: true,
				heard: this.heard(replyId),
			});
		}
		const added = await this.read(request, feed, part);
		return added instanceof Response
			? added
			: Response.json({ accepted: added, heard: this.heard(replyId) });
	}

	/** Adds the part's sentences to `feed`, or the response that refuses it. */
	async read(
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
}

/** `call`, or a failure once `ms` pass without it settling. */
async function within<T>(call: Promise<T>, ms: number): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | null = null;
	const late = new Promise<never>((_, reject) => {
		timer = setTimeout(
			() => reject(new Error(`Aura did not answer within ${ms} ms`)),
			ms,
		);
	});
	try {
		return await Promise.race([call, late]);
	} finally {
		clearTimeout(timer);
	}
}

async function requestClip(
	ai: ParlumeAuraBinding,
	text: string,
	startMs: number,
): Promise<ReadableStream<Uint8Array>> {
	// Raw 24 kHz 16-bit mono PCM: the response is labelled audio/mpeg but
	// carries no container with these inputs.
	const response = await within(
		ai.run(
			PARLUME_AURA_MODEL,
			{
				text,
				speaker: AURA_SPEAKER,
				encoding: "linear16",
				container: "none",
				sample_rate: AURA_SAMPLE_RATE,
			},
			{ returnRawResponse: true },
		),
		startMs,
	);
	if (!response.ok) {
		throw new Error(`Aura returned HTTP ${response.status}`);
	}
	if (!response.body) {
		throw new Error("Aura returned no audio");
	}
	return response.body;
}

/** How one attempt at a sentence's clip ended. */
type ClipOutcome =
	| { outcome: "played" | "stopped" }
	| { outcome: "failed"; error: string };

function errorText(error: unknown): string {
	return (error instanceof Error ? error.message : String(error)).slice(
		0,
		200,
	);
}

/**
 * Synthesizes `sentences` in order and plays them as one reply. Synthesis of a
 * sentence starts as soon as it arrives, so the next one is ready while the
 * current one plays. Stops quietly when the reply stops being current. When
 * `sentences` fails, what it queued is dropped and the failure is thrown.
 *
 * A sentence Aura fails on is asked for once more after `RETRY_MS`, and
 * played from its start even when part of it was queued: a short repeat is
 * better than a lost clause, and one error does not change the voice. Only
 * a second failure reports `failedAt`.
 *
 * Once `endAtSentence` is true, no further sentence starts: the one playing
 * goes on to its end, the outlet drains it, and the reply is not complete.
 */
export async function playParlumeAuraSentences(input: {
	ai: ParlumeAuraBinding;
	sentences: AsyncIterable<string>;
	outlet: ParlumeAuraOutlet;
	isCurrent: () => boolean;
	endAtSentence?: () => boolean;
	now?: () => number;
	/** How long a sentence's synthesis may take to start; tests shorten it. */
	clipStartMs?: number;
	/** How long a failed sentence waits to be retried; tests shorten it. */
	retryMs?: number;
	onRetry?: (retry: ParlumeAuraRetry) => void;
	/** How many sentences, from the first, were heard so far. */
	onHeard?: (heard: number) => void;
}): Promise<ParlumeAuraPlayback> {
	const { ai, outlet } = input;
	let withdrawn: { cause: unknown } | null = null;
	const isCurrent = () => withdrawn === null && input.isCurrent();
	// Set when `endAtSentence` kept a sentence from starting.
	let endedAtSentence = false;
	const mayStartSentence = () => {
		if (input.endAtSentence?.()) {
			endedAtSentence = true;
			return false;
		}
		return true;
	};
	const now = input.now ?? Date.now;
	const clipStartMs = input.clipStartMs ?? CLIP_START_MS;
	const origin = now();
	const texts: string[] = [];
	const timings: ParlumeAuraSentence[] = [];
	const clips: Array<Promise<ReadableStream<Uint8Array>>> = [];
	const played: boolean[] = [];
	// Bytes handed to the outlet up to the end of each fully played sentence.
	const sentenceEnds: number[] = [];
	let enqueuedBytes = 0;
	const droppedAtStart = outlet.droppedBytes;
	let firstAudioAt: number | undefined;
	let failedAt: number | undefined;
	let error: string | undefined;
	let chain: Promise<boolean> = Promise.resolve(true);

	// A sentence played to its end is heard once the outlet sends it, unless
	// a stop dropped speech first.
	const noteEnd = (index: number) => {
		const onHeard = input.onHeard;
		if (onHeard) {
			void outlet.drained().then(() => {
				if (outlet.droppedBytes === droppedAtStart) {
					onHeard(index + 1);
				}
			});
		}
	};

	const play = async (index: number): Promise<boolean> => {
		if (!mayStartSentence()) {
			return false;
		}
		const first = await playClip(index, clips[index]);
		if (first.outcome !== "failed") {
			return first.outcome === "played";
		}
		const replayed = timings[index].ok;
		await new Promise((resolve) =>
			setTimeout(resolve, input.retryMs ?? RETRY_MS),
		);
		if (!isCurrent()) {
			return false;
		}
		const clip = requestClip(ai, texts[index], clipStartMs);
		const second = await playClip(index, clip);
		input.onRetry?.({
			sentence: index,
			replayed,
			played: second.outcome === "played",
		});
		if (second.outcome === "failed") {
			error = second.error;
			// The caller speaks it again from its start.
			failedAt = index;
			return false;
		}
		return second.outcome === "played";
	};

	const playClip = async (
		index: number,
		clip: Promise<ReadableStream<Uint8Array>>,
	): Promise<ClipOutcome> => {
		const timing = timings[index];
		const begun = origin + timing.startedAtMs;
		let bytes = 0;
		let carry: number | null = null;
		let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
		try {
			const stream = await clip;
			reader = stream.getReader();
			for (;;) {
				const { done, value } = await reader.read();
				if (!isCurrent()) {
					await reader.cancel().catch(() => {});
					return { outcome: "stopped" };
				}
				if (value && value.byteLength > 0) {
					bytes += value.byteLength;
					if (bytes > MAX_CLIP_BYTES) {
						throw new Error("Aura exceeded the audio limit");
					}
					let chunk = value;
					if (carry !== null) {
						const joined = new Uint8Array(chunk.byteLength + 1);
						joined[0] = carry;
						joined.set(chunk, 1);
						chunk = joined;
						carry = null;
					}
					if (chunk.byteLength % 2 !== 0) {
						carry = chunk[chunk.byteLength - 1];
						chunk = chunk.subarray(0, chunk.byteLength - 1);
					}
					const at = now();
					timing.firstByteMs ??= at - begun;
					timing.totalMs = at - begun;
					if (chunk.byteLength > 0) {
						firstAudioAt ??= at;
						enqueuedBytes += chunk.byteLength;
						outlet.enqueue(chunk);
						timing.ok = true;
					}
				}
				if (done) {
					if (bytes === 0) {
						throw new Error("Aura returned no audio");
					}
					played[index] = true;
					sentenceEnds[index] = enqueuedBytes;
					noteEnd(index);
					return { outcome: "played" };
				}
			}
		} catch (cause) {
			played[index] = false;
			return { outcome: "failed", error: errorText(cause) };
		} finally {
			reader?.releaseLock();
		}
	};

	try {
		for await (const text of input.sentences) {
			if (!isCurrent() || failedAt !== undefined || !mayStartSentence()) {
				break;
			}
			const index = timings.length;
			texts.push(text);
			timings.push({
				chars: text.length,
				startedAtMs: now() - origin,
				firstByteMs: null,
				totalMs: null,
				ok: false,
			});
			const clip = requestClip(ai, text, clipStartMs);
			// Awaited in turn by `play`; until then a failure must not go unhandled.
			clip.catch(() => {});
			clips.push(clip);
			chain = chain.then((ok) => (ok ? play(index) : false));
		}
	} catch (cause) {
		// The sentence playing stops at its next chunk.
		withdrawn = { cause };
	}
	const complete = await chain;
	if (
		timings.length === 0 &&
		failedAt === undefined &&
		!endedAtSentence &&
		isCurrent()
	) {
		failedAt = 0;
		error = "Parlume had nothing to say";
	}
	// Clips requested but never played release their connection.
	for (let index = 0; index < clips.length; index++) {
		if (played[index] === undefined) {
			clips[index].then(
				(stream) => stream.cancel().catch(() => {}),
				() => {},
			);
		}
	}
	if (withdrawn) {
		outlet.clear();
		throw withdrawn.cause;
	}
	if ((complete || endedAtSentence) && isCurrent()) {
		outlet.end();
		await outlet.drained();
	} else if (failedAt !== undefined) {
		// What was queued before the failure still has to flush; the caller's
		// replacement audio follows it.
		outlet.end();
	} else {
		outlet.clear();
	}
	const heardBytes = enqueuedBytes - (outlet.droppedBytes - droppedAtStart);
	let heard = 0;
	while (
		sentenceEnds[heard] !== undefined &&
		sentenceEnds[heard] <= heardBytes
	) {
		heard++;
	}
	return {
		complete: complete && failedAt === undefined && isCurrent(),
		failedAt,
		error,
		firstAudioAt,
		heard,
		sentences: timings,
	};
}
