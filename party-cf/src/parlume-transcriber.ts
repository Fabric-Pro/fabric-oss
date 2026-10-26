// Audio held while the transcription stream (re)connects: the turn Flux was
// hearing when it dropped, and what arrived since, up to thirty seconds at
// 16 kHz 16-bit mono. Older audio is dropped rather than replayed late.
const MAX_PENDING_BYTES = 16_000 * 2 * 30;
const MAX_UNFINISHED_MS = 30_000;
// Flux reports a turn's start a moment after its first words.
const UNFINISHED_LEAD_MS = 3_000;
// Held audio goes to a new stream at three times real time. Sent all at once,
// Flux lost the first 4.6 s of a 15 s backlog and the words just after it,
// and its timestamps came back 4.6 s early; at 1.5, 2, 3 and 4 times real
// time it transcribed the same recording exactly as when streamed live.
const CATCH_UP_SPEED = 3;
const RECONNECT_DELAYS_MS = [500, 1_000, 2_000, 5_000, 10_000];
// Deepgram asks for Flux audio in 80 ms chunks. The meeting bot delivers 10 ms
// at a time, and Flux sent a hundred of those a second transcribed nothing.
const FLUX_CHUNK_MS = 80;
// The meeting bot sends no audio while it posts a chat message, which took up
// to ten seconds for a long post, and Flux closes a stream that hears nothing
// for five to seven seconds with 1011. Silence fills a gap, a second behind
// the meeting while it lasts and the rest when audio resumes, and Flux then
// placed the next words where the meeting heard them.
const GAP_FILL_LAG_MS = 1_000;
// A bot that sends nothing for this long has stopped; Flux is not kept open on
// silence for it.
const GAP_FILL_MAX_MS = 30_000;
// Larger jumps are not filled at once, which Flux would hear as a burst; the
// clock map below places the audio after them.
const GAP_PAD_MAX_MS = 2_000;
// Shorter pauses, and shorter differences between the meeting clock and the
// audio sent, are jitter, not missing audio.
const GAP_MIN_MS = 250;
const MAX_CLOCK_ANCHORS = 256;

/** Times are epoch milliseconds on the provider's audio clock. */
export interface ParlumeTranscript {
	text: string;
	isFinal: boolean;
	startMs: number;
	endMs: number;
	/**
	 * Flux's early guess that the turn has ended ("eager"), which it takes
	 * back ("resumed") when the speaker goes on. Neither is final.
	 */
	tentative?: "eager" | "resumed";
}

export interface ParlumeTranscriptionSocket {
	accept(): void;
	send(data: ArrayBuffer): void;
	close(code?: number, reason?: string): void;
	addEventListener(
		type: "message",
		listener: (event: { data: unknown }) => void,
	): void;
	addEventListener(
		type: "close",
		listener: (event: { code: number; reason: string }) => void,
	): void;
	addEventListener(type: "error", listener: () => void): void;
}

interface TranscriberOptions {
	/** Rate of the 16-bit mono PCM passed to `send`. */
	sampleRate: number;
	connect: () => Promise<ParlumeTranscriptionSocket>;
	onTranscript: (transcript: ParlumeTranscript) => void;
	onStatus: (
		status: "connected" | "failed" | "closed",
		detail?: string,
	) => void;
	now?: () => number;
}

interface FluxEvent {
	event: string;
	turnIndex: number;
	transcript: string;
	windowStart: number | null;
	windowEnd: number | null;
	wordBounds: { start: number; end: number } | null;
}

function readWordBounds(
	words: unknown,
	windowEnd: number | null,
): FluxEvent["wordBounds"] {
	if (!Array.isArray(words) || words.length === 0) {
		return null;
	}
	const values: unknown[] = words;
	let start: number | null = null;
	let end = 0;
	let previousStart = 0;
	for (const word of values) {
		if (
			typeof word !== "object" ||
			word === null ||
			!("start" in word) ||
			!("end" in word) ||
			typeof word.start !== "number" ||
			typeof word.end !== "number" ||
			!Number.isFinite(word.start) ||
			!Number.isFinite(word.end) ||
			word.start < previousStart ||
			word.end < word.start ||
			word.end > Number.MAX_SAFE_INTEGER / 1000 ||
			word.end < end ||
			(windowEnd !== null &&
				Number.isFinite(windowEnd) &&
				word.end > windowEnd)
		) {
			return null;
		}
		previousStart = word.start;
		start ??= word.start;
		end = word.end;
	}
	return start === null ? null : { start, end };
}

function readFluxEvent(data: unknown): FluxEvent | null {
	if (typeof data !== "string") {
		return null;
	}
	let value: unknown;
	try {
		value = JSON.parse(data);
	} catch {
		return null;
	}
	if (
		typeof value !== "object" ||
		value === null ||
		!("event" in value) ||
		typeof value.event !== "string"
	) {
		return null;
	}
	const fields: Record<string, unknown> = { ...value };
	const windowEnd =
		typeof fields.audio_window_end === "number"
			? fields.audio_window_end
			: null;
	return {
		event: value.event,
		turnIndex:
			typeof fields.turn_index === "number" ? fields.turn_index : 0,
		transcript:
			typeof fields.transcript === "string"
				? fields.transcript.trim()
				: "",
		windowStart:
			typeof fields.audio_window_start === "number"
				? fields.audio_window_start
				: null,
		windowEnd,
		wordBounds: readWordBounds(fields.words, windowEnd),
	};
}

/**
 * Streams the meeting's mixed audio to Deepgram Flux on Workers AI. Flux
 * decides where a speaker's turn ends and reports it as final; its partial
 * updates are reported too, so live speech can interrupt Parlume. A gap in the
 * meeting audio reaches Flux as silence; a dropped stream reconnects on the
 * next audio chunk, with backoff after failures.
 */
export class ParlumeTranscriber {
	private socket: ParlumeTranscriptionSocket | null = null;
	private connecting = false;
	private pending: { chunk: ArrayBuffer; epochMs: number }[] = [];
	private pendingBytes = 0;
	/**
	 * Audio sent since Flux last ended a turn. Flux closes the stream with
	 * 1011 now and then, mid-sentence; the new stream hears this again, so
	 * the sentence is not lost.
	 */
	private unfinished: { chunk: ArrayBuffer; epochMs: number }[] = [];
	private catchingUp: ReturnType<typeof setTimeout> | null = null;
	/**
	 * Where audio sent to the current stream sits on the meeting clock: Flux
	 * counts time by the audio it has heard, and each anchor marks where that
	 * count and the meeting clock last moved apart.
	 */
	private clock: { fluxMs: number; epochMs: number }[] = [];
	private fluxSentMs = 0;
	/** Meeting-clock end of the audio delivered so far, silence included. */
	private deliveredUntilMs: number | null = null;
	/** When the meeting bot last sent audio, and where it ended. */
	private heard: { at: number; untilMs: number } | null = null;
	private gapFill: ReturnType<typeof setTimeout> | null = null;
	private turnStarts = new Map<number, number>();
	private failures = 0;
	private retryAt = 0;
	private closed = false;
	private batchesSent = 0;
	private eventsReceived = 0;
	private batch: Uint8Array[] = [];
	private batchBytes = 0;
	private batchEpochMs = 0;
	private readonly batchTargetBytes: number;
	private readonly bytesPerMs: number;
	private readonly options: TranscriberOptions;

	constructor(options: TranscriberOptions) {
		this.options = options;
		this.bytesPerMs = (options.sampleRate * 2) / 1000;
		this.batchTargetBytes = this.bytesPerMs * FLUX_CHUNK_MS;
	}

	send(chunk: ArrayBuffer, epochMs: number): void {
		if (this.closed) {
			return;
		}
		const now = this.now();
		// Only a bot that stopped sending dropped audio; a meeting clock that
		// merely drifts from the audio is followed by the clock map instead.
		if (this.heard && now - this.heard.at >= GAP_MIN_MS) {
			this.flushBatch();
			this.padGapBefore(epochMs);
		}
		if (this.batchBytes === 0) {
			this.batchEpochMs = epochMs;
		}
		this.batch.push(new Uint8Array(chunk));
		this.batchBytes += chunk.byteLength;
		this.heard = {
			at: now,
			untilMs: epochMs + chunk.byteLength / this.bytesPerMs,
		};
		this.scheduleGapFill(GAP_FILL_LAG_MS);
		if (this.batchBytes >= this.batchTargetBytes) {
			this.flushBatch();
		}
	}

	private flushBatch(): void {
		if (this.batchBytes === 0) {
			return;
		}
		const joined = new Uint8Array(this.batchBytes);
		let offset = 0;
		for (const part of this.batch) {
			joined.set(part, offset);
			offset += part.length;
		}
		this.batch = [];
		this.batchBytes = 0;
		this.deliver(joined.buffer, this.batchEpochMs);
	}

	private deliver(chunk: ArrayBuffer, epochMs: number): void {
		this.deliveredUntilMs = epochMs + chunk.byteLength / this.bytesPerMs;
		if (this.socket && !this.catchingUp) {
			this.forward(this.socket, chunk, epochMs);
			return;
		}
		this.hold(chunk, epochMs);
		if (!this.socket) {
			void this.connect();
		}
	}

	private hold(chunk: ArrayBuffer, epochMs: number): void {
		this.pending.push({ chunk, epochMs });
		this.pendingBytes += chunk.byteLength;
		this.trimPending();
	}

	/**
	 * Audio resumed after a gap the live fill has not covered: the rest goes
	 * ahead of it as silence, at catch-up speed. Audio held for a new stream
	 * is not padded; the clock map places it.
	 */
	private padGapBefore(epochMs: number): void {
		const from = this.deliveredUntilMs;
		if (!this.socket || from === null || epochMs - from < GAP_MIN_MS) {
			return;
		}
		const until = from + Math.min(epochMs - from, GAP_PAD_MAX_MS);
		for (let at = from; at < until; at += FLUX_CHUNK_MS) {
			this.hold(this.silence(Math.min(FLUX_CHUNK_MS, until - at)), at);
		}
		this.deliveredUntilMs = until;
		if (!this.catchingUp) {
			this.catchUp(this.socket);
		}
	}

	private scheduleGapFill(delayMs: number): void {
		if (this.gapFill) {
			clearTimeout(this.gapFill);
		}
		this.gapFill = setTimeout(() => this.fillGap(), delayMs);
	}

	/**
	 * Keeps an open stream hearing silence, a second behind the meeting, while
	 * the meeting bot sends nothing.
	 */
	private fillGap(): void {
		this.gapFill = null;
		const heard = this.heard;
		if (!heard || !this.socket) {
			return;
		}
		const quietMs = this.now() - heard.at;
		if (quietMs < GAP_FILL_LAG_MS || quietMs > GAP_FILL_MAX_MS) {
			return;
		}
		this.flushBatch();
		const until = heard.untilMs + quietMs - GAP_FILL_LAG_MS;
		while (
			this.deliveredUntilMs !== null &&
			this.deliveredUntilMs + FLUX_CHUNK_MS <= until
		) {
			this.deliver(this.silence(FLUX_CHUNK_MS), this.deliveredUntilMs);
		}
		this.scheduleGapFill(FLUX_CHUNK_MS);
	}

	private silence(ms: number): ArrayBuffer {
		return new ArrayBuffer(Math.round((ms * this.bytesPerMs) / 2) * 2);
	}

	private now(): number {
		return this.options.now?.() ?? Date.now();
	}

	/**
	 * Sends held audio to a new stream at `CATCH_UP_SPEED`, live audio
	 * queuing behind it, until the stream has caught up with the meeting.
	 */
	private catchUp(socket: ParlumeTranscriptionSocket): void {
		this.catchingUp = null;
		if (this.socket !== socket) {
			return;
		}
		const next = this.pending.shift();
		if (!next) {
			return;
		}
		this.pendingBytes -= next.chunk.byteLength;
		this.forward(socket, next.chunk, next.epochMs);
		if (this.pending.length === 0) {
			return;
		}
		this.catchingUp = setTimeout(
			() => this.catchUp(socket),
			next.chunk.byteLength / this.bytesPerMs / CATCH_UP_SPEED,
		);
	}

	private stopCatchingUp(): void {
		if (this.catchingUp) {
			clearTimeout(this.catchingUp);
			this.catchingUp = null;
		}
	}

	private trimPending(): void {
		while (this.pendingBytes > MAX_PENDING_BYTES) {
			const dropped = this.pending.shift();
			this.pendingBytes -= dropped?.chunk.byteLength ?? this.pendingBytes;
		}
	}

	/** Batches sent to Flux and events it returned since the last call. */
	takeStats(): { batchesSent: number; eventsReceived: number } {
		const stats = {
			batchesSent: this.batchesSent,
			eventsReceived: this.eventsReceived,
		};
		this.batchesSent = 0;
		this.eventsReceived = 0;
		return stats;
	}

	close(): void {
		this.closed = true;
		this.stopCatchingUp();
		if (this.gapFill) {
			clearTimeout(this.gapFill);
			this.gapFill = null;
		}
		this.batch = [];
		this.batchBytes = 0;
		this.pending = [];
		this.pendingBytes = 0;
		this.unfinished = [];
		const socket = this.socket;
		this.socket = null;
		socket?.close(1000, "meeting stream closed");
	}

	private forward(
		socket: ParlumeTranscriptionSocket,
		chunk: ArrayBuffer,
		epochMs: number,
	): void {
		const last = this.clock.at(-1);
		if (
			!last ||
			Math.abs(last.epochMs + this.fluxSentMs - last.fluxMs - epochMs) >=
				GAP_MIN_MS
		) {
			this.clock.push({ fluxMs: this.fluxSentMs, epochMs });
			if (this.clock.length > MAX_CLOCK_ANCHORS) {
				this.clock.shift();
			}
		}
		this.fluxSentMs += chunk.byteLength / this.bytesPerMs;
		socket.send(chunk);
		this.batchesSent++;
		this.unfinished.push({ chunk, epochMs });
		// Between turns only the lead-in to the next one is kept, so a long
		// silence is not replayed.
		const turnStart = Math.min(epochMs, ...this.turnStarts.values());
		this.forgetUnfinishedBefore(
			Math.max(
				turnStart - UNFINISHED_LEAD_MS,
				epochMs - MAX_UNFINISHED_MS,
			),
		);
	}

	private forgetUnfinishedBefore(ms: number): void {
		while (this.unfinished.length) {
			const { chunk, epochMs } = this.unfinished[0];
			if (epochMs + chunk.byteLength / this.bytesPerMs > ms) {
				return;
			}
			this.unfinished.shift();
		}
	}

	private async connect(): Promise<void> {
		const now = this.options.now?.() ?? Date.now();
		if (
			this.connecting ||
			this.socket ||
			this.closed ||
			now < this.retryAt
		) {
			return;
		}
		this.connecting = true;
		try {
			const socket = await this.options.connect();
			socket.accept();
			if (this.closed) {
				socket.close(1000, "meeting stream closed");
				return;
			}
			socket.addEventListener("message", (event) =>
				this.receive(socket, event.data),
			);
			socket.addEventListener("close", (event) =>
				this.drop(socket, `${event.code} ${event.reason}`.trim()),
			);
			socket.addEventListener("error", () => this.drop(socket, "error"));
			this.socket = socket;
			this.clock = [];
			this.fluxSentMs = 0;
			this.turnStarts.clear();
			this.failures = 0;
			this.options.onStatus("connected");
			this.catchUp(socket);
		} catch (error) {
			this.failures++;
			this.retryAt =
				(this.options.now?.() ?? Date.now()) +
				(RECONNECT_DELAYS_MS[
					Math.min(this.failures, RECONNECT_DELAYS_MS.length) - 1
				] ?? 0);
			this.options.onStatus(
				"failed",
				error instanceof Error
					? error.message.slice(0, 200)
					: "unknown",
			);
		} finally {
			this.connecting = false;
		}
	}

	private drop(socket: ParlumeTranscriptionSocket, detail: string): void {
		if (this.socket !== socket) {
			return;
		}
		this.socket = null;
		this.stopCatchingUp();
		if (this.closed) {
			return;
		}
		this.options.onStatus("closed", detail);
		this.pending = [...this.unfinished, ...this.pending];
		this.pendingBytes = this.pending.reduce(
			(bytes, { chunk }) => bytes + chunk.byteLength,
			0,
		);
		this.unfinished = [];
		this.trimPending();
	}

	private receive(socket: ParlumeTranscriptionSocket, data: unknown): void {
		if (this.socket === socket) {
			this.eventsReceived++;
		}
		const event = readFluxEvent(data);
		const clock = this.clock;
		if (this.socket !== socket || clock.length === 0 || !event) {
			return;
		}
		const at = (seconds: number | null) => {
			const fluxMs = Math.max(0, seconds ?? 0) * 1000;
			let anchor = clock[0];
			for (const next of clock) {
				if (next.fluxMs > fluxMs) {
					break;
				}
				anchor = next;
			}
			return anchor.epochMs + fluxMs - anchor.fluxMs;
		};
		const wordBounds = event.transcript ? event.wordBounds : null;
		const startMs = wordBounds
			? at(wordBounds.start)
			: (this.turnStarts.get(event.turnIndex) ?? at(event.windowStart));
		const endMs = at(wordBounds?.end ?? event.windowEnd);
		if (event.event === "StartOfTurn" || event.event === "Update") {
			if (wordBounds || !this.turnStarts.has(event.turnIndex)) {
				this.turnStarts.set(event.turnIndex, startMs);
			}
			if (event.event === "StartOfTurn" || event.transcript) {
				this.options.onTranscript({
					text: event.transcript,
					isFinal: false,
					startMs,
					endMs,
				});
			}
			return;
		}
		if (event.event === "EagerEndOfTurn" || event.event === "TurnResumed") {
			this.options.onTranscript({
				text: event.transcript,
				isFinal: false,
				startMs,
				endMs,
				tentative:
					event.event === "EagerEndOfTurn" ? "eager" : "resumed",
			});
			return;
		}
		if (event.event !== "EndOfTurn") {
			return;
		}
		this.turnStarts.delete(event.turnIndex);
		this.forgetUnfinishedBefore(endMs);
		if (event.transcript) {
			this.options.onTranscript({
				text: event.transcript,
				isFinal: true,
				startMs,
				endMs,
			});
		}
	}
}
