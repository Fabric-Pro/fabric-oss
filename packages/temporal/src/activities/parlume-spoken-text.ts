// A sentence shorter than this waits for the next one, so the voice never
// starts on a fragment such as "Sure." followed by a pause.
const MIN_SENTENCE_CHARS = 24;
const SENTENCE_END = /[.!?…](?:["')\]]*)\s+/g;

const BARE_URL = /\b(?:https?:\/\/|www\.)[^\s<>()]+/gi;

/**
 * Markdown the agent may write that a voice should not read aloud, and every
 * URL: a link is posted in the meeting chat, never spelled out.
 */
export function toSpokenText(text: string): string {
	return text
		.replace(/```[\s\S]*?```/g, " ")
		.replace(/`([^`]*)`/g, "$1")
		.replace(/\*\*|__|~~/g, "")
		.replace(/^\s{0,3}#{1,6}\s+/gm, "")
		.replace(/^\s*[-*+]\s+/gm, "")
		.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
		.replace(BARE_URL, (url) => {
			const trailing = /[.,;:!?'"\]]+$/.exec(url)?.[0] ?? "";
			return `the link${trailing}`;
		})
		.replace(/\s+/g, " ")
		.trim();
}

/**
 * Sentences read once from a source and replayable from any index, so a reply
 * handed to one speech route can be continued by another from where the first
 * stopped. Consumers share one pull at a time.
 */
export class ReplayableSentences {
	private readonly iterator: AsyncIterator<string>;
	private readonly cache: string[] = [];
	private finished = false;
	private failure: { error: unknown } | null = null;
	private pulling: Promise<void> | null = null;

	constructor(source: AsyncIterable<string>) {
		this.iterator = source[Symbol.asyncIterator]();
	}

	async *from(start: number): AsyncGenerator<string> {
		let index = start;
		for (;;) {
			if (index < this.cache.length) {
				yield this.cache[index++];
				continue;
			}
			if (this.failure) {
				throw this.failure.error;
			}
			if (this.finished) {
				return;
			}
			await this.pull();
		}
	}

	private pull(): Promise<void> {
		this.pulling ??= (async () => {
			try {
				const next = await this.iterator.next();
				if (next.done) {
					this.finished = true;
				} else {
					this.cache.push(next.value);
				}
			} catch (error) {
				this.failure = { error };
			} finally {
				this.pulling = null;
			}
		})();
		return this.pulling;
	}
}

/**
 * Sentences taken in batches of whatever already exists: each `next` waits
 * for at least one sentence, or for the end, then takes every sentence that
 * is ready by the next turn of the event loop without waiting for more.
 */
export class AvailableSentences {
	private pending: Promise<IteratorResult<string>> | null = null;

	constructor(private readonly source: AsyncIterator<string>) {}

	async next(): Promise<{ sentences: string[]; last: boolean }> {
		const sentences: string[] = [];
		for (;;) {
			this.pending ??= this.source.next();
			const pulling = this.pending;
			if (sentences.length > 0 && !(await settlesNow(pulling))) {
				return { sentences, last: false };
			}
			const result = await pulling;
			this.pending = null;
			if (result.done) {
				return { sentences, last: true };
			}
			sentences.push(result.value);
		}
	}
}

async function settlesNow(promise: Promise<unknown>): Promise<boolean> {
	let settled = false;
	promise.then(
		() => {
			settled = true;
		},
		() => {
			settled = true;
		},
	);
	await new Promise<void>((resolve) => setImmediate(resolve));
	return settled;
}

/**
 * The answer as speakable sentences, released one by one while the agent is
 * still writing, so the first sentence can be synthesized and played before
 * the rest exists. Iterating ends after `end()`, once everything pushed has
 * been released. Speech stops at `maxChars`: the sentence that would cross it
 * and everything after are kept as written in `overflowText`, never dropped.
 */
export class ParlumeSentenceQueue implements AsyncIterable<string> {
	private pending = "";
	private ready: string[] = [];
	private released = 0;
	// What each released sentence was before it was made speakable, by
	// release order; empty for a line Parlume says of its own accord.
	private readonly written: string[] = [];
	private overflow = "";
	private full = false;
	private ended = false;
	private waiter: (() => void) | null = null;
	private maxChars: number;

	constructor(maxChars: number) {
		this.maxChars = maxChars;
	}

	/** Raises the speech limit, unless speech has already stopped at the old one. */
	extendTo(maxChars: number): void {
		if (!this.full) {
			this.maxChars = Math.max(this.maxChars, maxChars);
		}
	}

	/** Answer text that will not be spoken: past the limit, or never speakable. */
	get overflowText(): string {
		return this.overflow.trim();
	}

	/**
	 * The answer as written, from the sentence at `index` on: what a listener
	 * did not hear when speech stopped there.
	 */
	writtenFrom(index: number): string {
		return [...this.written.slice(index), this.pending, this.overflow]
			.join("")
			.trim();
	}

	/**
	 * Speaks a line that is not part of the answer, such as a tool's
	 * narration, when it fits; it never appears in `writtenFrom`.
	 */
	narrate(line: string): void {
		if (this.ended || this.full) {
			return;
		}
		this.release(line, "");
		this.wake();
	}

	/** Speaks a closing line of Parlume's own, past the limit if need be. */
	announce(line: string): void {
		if (this.ended) {
			return;
		}
		this.speak(toSpokenText(line), "");
		this.wake();
	}

	static fromText(text: string, maxChars: number): ParlumeSentenceQueue {
		const queue = new ParlumeSentenceQueue(maxChars);
		queue.push(text);
		queue.end();
		return queue;
	}

	/** Whether any text has been pushed. */
	get received(): boolean {
		return (
			this.pending.length > 0 ||
			this.ready.length > 0 ||
			this.released > 0
		);
	}

	push(text: string): void {
		if (this.ended || !text) {
			return;
		}
		this.pending += text;
		let cut = 0;
		for (const match of this.pending.matchAll(SENTENCE_END)) {
			const end = match.index + match[0].length;
			if (end - cut >= MIN_SENTENCE_CHARS) {
				this.release(this.pending.slice(cut, end));
				cut = end;
			}
		}
		this.pending = this.pending.slice(cut);
		this.wake();
	}

	/**
	 * Releases what has been pushed so far as a sentence now, however short and
	 * whether or not its end has been seen: used when the agent stops writing to
	 * run a tool, so a short line ahead of the tool is spoken while it runs.
	 */
	flush(): void {
		if (this.ended || !this.pending) {
			return;
		}
		// The agent's next words, after the tool, are written as a new block
		// with no space before them: kept apart from these as written.
		this.release(
			this.pending,
			/\s$/.test(this.pending) ? this.pending : `${this.pending} `,
		);
		this.pending = "";
		this.wake();
	}

	end(): void {
		if (this.ended) {
			return;
		}
		this.release(this.pending);
		this.pending = "";
		this.ended = true;
		this.wake();
	}

	async *[Symbol.asyncIterator](): AsyncIterator<string> {
		for (;;) {
			const sentence = this.ready.shift();
			if (sentence !== undefined) {
				yield sentence;
				continue;
			}
			if (this.ended) {
				return;
			}
			await new Promise<void>((resolve) => {
				this.waiter = resolve;
			});
		}
	}

	private release(text: string, written = text): void {
		if (this.full) {
			this.overflow += written;
			return;
		}
		const spoken = toSpokenText(text);
		if (!spoken) {
			// Only markup, such as a code block: the chat still gets it.
			this.overflow += written;
			return;
		}
		const room = this.maxChars - this.released;
		if (spoken.length <= room) {
			this.speak(spoken, written);
			return;
		}
		this.full = true;
		this.overflow += written;
		// A first sentence longer than the limit is begun rather than left
		// unsaid; the chat gets it whole.
		if (this.released === 0) {
			this.speak(spoken.slice(0, room), "");
		}
	}

	private speak(spoken: string, written: string): void {
		if (!spoken) {
			return;
		}
		this.released += spoken.length;
		this.ready.push(spoken);
		this.written.push(written);
	}

	private wake(): void {
		const waiter = this.waiter;
		this.waiter = null;
		waiter?.();
	}
}

/** A line holding only this separates a spoken reply's headline from its detail. */
export const PARLUME_DETAIL_MARKER = "---";
/** Said when the meeting chat is out of reach and the reply did not fit. */
export const PARLUME_MORE_LINE = "There's more; ask me to continue.";
// A line so far that may still turn out to be the marker.
const MARKER_SO_FAR = /^[ \t]*-{0,3}[ \t]*$/;

function joinParts(...parts: string[]): string {
	return parts
		.map((part) => part.trim())
		.filter(Boolean)
		.join("\n\n");
}

/**
 * A spoken reply as the agent writes it: a headline of a sentence or two,
 * then, when there is more, a line holding only `---` and the detail. The
 * headline is spoken as it arrives; the detail, and any headline past the
 * speech limit, is kept for the meeting chat. When the chat is out of reach,
 * the detail is spoken too, up to a longer limit, and Parlume says there is
 * more instead of stopping without a word.
 */
export class ParlumeSpokenReply {
	// The start of a line held back while it may still be the marker.
	private line = "";
	private atLineStart = true;
	private detail = "";
	private inDetail = false;
	private voiceOnly = false;
	private answered = false;

	constructor(readonly speech: ParlumeSentenceQueue) {}

	/** Whether any of the answer has arrived; narration does not count. */
	get received(): boolean {
		return this.answered;
	}

	/** The meeting chat is out of reach: speak the detail as well, up to `maxChars`. */
	speakEverything(maxChars: number): void {
		this.voiceOnly = true;
		this.speech.extendTo(maxChars);
		const detail = this.detail;
		this.detail = "";
		this.speech.push(detail);
	}

	push(text: string): void {
		if (!text) {
			return;
		}
		this.answered = true;
		if (this.inDetail && !this.voiceOnly) {
			this.detail += text;
			return;
		}
		let rest = this.line + text;
		this.line = "";
		// Whether `rest` starts a line: only a whole line can be the marker.
		let lineStart = this.atLineStart;
		for (
			let newline = rest.indexOf("\n");
			newline >= 0;
			newline = rest.indexOf("\n")
		) {
			const line = rest.slice(0, newline);
			rest = rest.slice(newline + 1);
			const marker = lineStart && line.trim() === PARLUME_DETAIL_MARKER;
			lineStart = true;
			if (!marker) {
				this.speech.push(`${line}\n`);
				continue;
			}
			this.inDetail = true;
			if (!this.voiceOnly) {
				this.detail += rest;
				return;
			}
		}
		if (lineStart && MARKER_SO_FAR.test(rest)) {
			this.line = rest;
			this.atLineStart = true;
		} else {
			this.speech.push(rest);
			this.atLineStart = false;
		}
	}

	end(): void {
		if (this.line.trim() === PARLUME_DETAIL_MARKER) {
			this.inDetail = true;
		} else {
			this.speech.push(this.line);
		}
		this.line = "";
		this.speech.flush();
		if (this.voiceOnly && this.speech.overflowText) {
			this.speech.announce(PARLUME_MORE_LINE);
		}
		this.speech.end();
	}

	/** What the meeting chat gets after the reply was heard: the detail and anything past the limit. */
	get chatText(): string {
		return joinParts(this.speech.overflowText, this.detail);
	}

	/** What the meeting chat gets when only `heard` sentences were heard: the rest of the answer. */
	unheardText(heard: number): string {
		return joinParts(this.speech.writtenFrom(heard), this.detail);
	}
}
