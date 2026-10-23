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

export interface ParlumeAuraPlayback {
	/** Every sentence was synthesized and played while the reply was current. */
	complete: boolean;
	/**
	 * The first sentence that has no audio at the outlet, when synthesis failed.
	 * Sentences before it were played; the caller may speak the rest itself.
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

async function requestClip(
	ai: ParlumeAuraBinding,
	text: string,
): Promise<ReadableStream<Uint8Array>> {
	// Raw 24 kHz 16-bit mono PCM: the response is labelled audio/mpeg but
	// carries no container with these inputs.
	const response = await ai.run(
		PARLUME_AURA_MODEL,
		{
			text,
			speaker: AURA_SPEAKER,
			encoding: "linear16",
			container: "none",
			sample_rate: AURA_SAMPLE_RATE,
		},
		{ returnRawResponse: true },
	);
	if (!response.ok) {
		throw new Error(`Aura returned HTTP ${response.status}`);
	}
	if (!response.body) {
		throw new Error("Aura returned no audio");
	}
	return response.body;
}

function errorText(error: unknown): string {
	return (error instanceof Error ? error.message : String(error)).slice(
		0,
		200,
	);
}

/**
 * Synthesizes `sentences` in order and plays them as one reply. Synthesis of a
 * sentence starts as soon as it arrives, so the next one is ready while the
 * current one plays. Stops quietly when the reply stops being current.
 */
export async function playParlumeAuraSentences(input: {
	ai: ParlumeAuraBinding;
	sentences: AsyncIterable<string>;
	outlet: ParlumeAuraOutlet;
	isCurrent: () => boolean;
	now?: () => number;
}): Promise<ParlumeAuraPlayback> {
	const { ai, outlet, isCurrent } = input;
	const now = input.now ?? Date.now;
	const origin = now();
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

	const play = async (index: number): Promise<boolean> => {
		const timing = timings[index];
		const begun = origin + timing.startedAtMs;
		let bytes = 0;
		let carry: number | null = null;
		let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
		try {
			const stream = await clips[index];
			reader = stream.getReader();
			for (;;) {
				const { done, value } = await reader.read();
				if (!isCurrent()) {
					await reader.cancel().catch(() => {});
					return false;
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
					return true;
				}
			}
		} catch (cause) {
			error = errorText(cause);
			// Audio already queued for this sentence is spoken; the caller
			// continues after it rather than saying it twice.
			failedAt = timing.ok ? index + 1 : index;
			played[index] = timing.ok;
			return false;
		} finally {
			reader?.releaseLock();
		}
	};

	for await (const text of input.sentences) {
		if (!isCurrent() || failedAt !== undefined) {
			break;
		}
		const index = timings.length;
		timings.push({
			chars: text.length,
			startedAtMs: now() - origin,
			firstByteMs: null,
			totalMs: null,
			ok: false,
		});
		const clip = requestClip(ai, text);
		// Awaited in turn by `play`; until then a failure must not go unhandled.
		clip.catch(() => {});
		clips.push(clip);
		chain = chain.then((ok) => (ok ? play(index) : false));
	}
	const complete = await chain;
	if (timings.length === 0 && failedAt === undefined && isCurrent()) {
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
	if (complete && isCurrent()) {
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
