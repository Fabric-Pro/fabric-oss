const SPOKEN_RECORD_KEY = "spokenRecord";
/**
 * How long a restarted bridge waits for the bot to come back before what was
 * cut short is no longer said: the worker posts the rest of an answer to the
 * chat, and a post read aloud is still in the chat.
 */
export const PARLUME_RESUME_WINDOW_MS = 15_000;

/**
 * What Parlume is saying, stored at each sentence end: the worker's reply
 * by its id, or a post the bridge reads aloud, with the sentences so far and
 * how many of them, from the first, were heard. A restart keeps it.
 */
type ParlumeSpokenRecord = {
	generation: number;
	sentences: string[];
	heard: number;
	/** When the latest sentence was heard to its end. */
	savedAt: number;
} & (
	| { kind: "reply"; replyId: string }
	| { kind: "read"; asker: string | null }
);

/** A post read aloud that a restart cut short, to read on from. */
interface ParlumeCutRead {
	asker: string | null;
	/** The sentences not heard, the one cut into first. */
	rest: string[];
	heard: number;
	/** Since its latest sentence was heard. */
	gapMs: number;
	/** At most this much of it played after that, and was lost. */
	lostMs: number;
}

/** The sentences, one at a time, as playback takes them. */
export async function* parlumeSentencesOf(
	sentences: readonly string[],
): AsyncGenerator<string> {
	yield* sentences;
}

/** All of `sentences`, for a read kept whole. */
export async function parlumeSentenceList(
	sentences: AsyncIterable<string>,
): Promise<string[]> {
	const list: string[] = [];
	for await (const sentence of sentences) {
		list.push(sentence);
	}
	return list;
}

/**
 * The record of the reply or read being spoken (one at a time: they take
 * turns), and the one a restart cut short. Each playback has a handle, so a
 * sentence heard after its playback ended changes nothing.
 */
export class ParlumeSpokenRecords {
	private current: { handle: number; record: ParlumeSpokenRecord } | null =
		null;
	private handles = 0;
	// Stored before the restart, and when the bridge started again.
	private cut: ParlumeSpokenRecord | null = null;
	private startedAt = 0;

	constructor(
		private readonly storage: Pick<
			DurableObjectStorage,
			"get" | "put" | "delete"
		>,
		private readonly now: () => number,
	) {}

	async load(): Promise<void> {
		this.cut =
			(await this.storage.get<ParlumeSpokenRecord>(SPOKEN_RECORD_KEY)) ??
			null;
		this.startedAt = this.now();
	}

	beginReply(replyId: string, generation: number): number {
		return this.begin({
			kind: "reply",
			replyId,
			generation,
			sentences: [],
			heard: 0,
			savedAt: this.now(),
		});
	}

	/** A read is kept whole: a restart reads on from any of `sentences`. */
	beginRead(
		asker: string | null,
		generation: number,
		sentences: readonly string[],
	): number {
		return this.begin({
			kind: "read",
			asker,
			generation,
			sentences: [...sentences],
			heard: 0,
			savedAt: this.now(),
		});
	}

	private begin(record: ParlumeSpokenRecord): number {
		const handle = ++this.handles;
		this.current = { handle, record };
		return handle;
	}

	noteSentence(handle: number, sentence: string): void {
		if (this.current?.handle === handle) {
			this.current.record.sentences.push(sentence);
		}
	}

	/** A sentence was heard to its end: the record is stored as it is now. */
	async noteHeard(handle: number, heard: number): Promise<void> {
		const record =
			this.current?.handle === handle ? this.current.record : null;
		if (!record || heard <= record.heard) {
			return;
		}
		record.heard = heard;
		record.savedAt = this.now();
		await this.storage.put(SPOKEN_RECORD_KEY, record);
	}

	/** The playback ended here, whole or not: there is nothing to resume. */
	async end(handle: number): Promise<void> {
		if (this.current?.handle !== handle) {
			return;
		}
		this.current = null;
		await this.storage.delete(SPOKEN_RECORD_KEY);
	}

	/**
	 * How many sentences of the worker's reply were heard, playing now or
	 * cut short by a restart; null for a reply this bridge knows nothing of.
	 */
	heard(replyId: string, generation: number): number | null {
		for (const record of [this.current?.record, this.cut]) {
			if (
				record?.kind === "reply" &&
				record.replyId === replyId &&
				record.generation === generation
			) {
				return record.heard;
			}
		}
		return null;
	}

	/**
	 * The post a restart cut short in its reading, taken once: only while
	 * its generation is current, and within `PARLUME_RESUME_WINDOW_MS` of the
	 * restart.
	 */
	takeCutRead(generation: number): ParlumeCutRead | null {
		const cut = this.cut;
		if (cut?.kind !== "read") {
			return null;
		}
		this.cut = null;
		const now = this.now();
		if (
			cut.generation !== generation ||
			cut.heard >= cut.sentences.length ||
			now - this.startedAt > PARLUME_RESUME_WINDOW_MS
		) {
			// Not read on: a later restart must not find it either.
			if (this.current === null) {
				void this.storage.delete(SPOKEN_RECORD_KEY);
			}
			return null;
		}
		return {
			asker: cut.asker,
			rest: cut.sentences.slice(cut.heard),
			heard: cut.heard,
			gapMs: now - cut.savedAt,
			lostMs: Math.max(0, this.startedAt - cut.savedAt),
		};
	}
}
