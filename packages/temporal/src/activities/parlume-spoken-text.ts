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
 * The answer as speakable sentences, released one by one while the agent is
 * still writing, so the first sentence can be synthesized and played before
 * the rest exists. Iterating ends after `end()`, once everything pushed has
 * been released, or when `maxChars` of speech have been released.
 */
export class ParlumeSentenceQueue implements AsyncIterable<string> {
	private pending = "";
	private ready: string[] = [];
	private released = 0;
	private ended = false;
	private waiter: (() => void) | null = null;
	private readonly maxChars: number;

	constructor(maxChars: number) {
		this.maxChars = maxChars;
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

	private release(text: string): void {
		const spoken = toSpokenText(text);
		const room = this.maxChars - this.released;
		if (!spoken || room <= 0) {
			return;
		}
		const sentence = spoken.slice(0, room);
		this.released += sentence.length;
		this.ready.push(sentence);
	}

	private wake(): void {
		const waiter = this.waiter;
		this.waiter = null;
		waiter?.();
	}
}
