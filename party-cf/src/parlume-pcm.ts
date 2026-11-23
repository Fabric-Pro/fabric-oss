// Fabric synthesizes speech as 24 kHz, 16-bit mono PCM and the bot is created
// at the same rate, so a reply reaches it unchanged.
export const PARLUME_SPEECH_SAMPLE_RATE = 24_000;
const MAX_BYTES = 6 * 1024 * 1024;
// Attendee re-chunks what it receives into 100 ms pieces and discards a
// shorter leftover when the next message is late, so whole 100 ms frames leave
// it nothing to drop.
const FRAME_MS = 100;
// Kept queued at the bot, so a late timer never leaves its sink without audio.
const LEAD_FRAMES = 2;
/** The most speech the bot still plays once the outlet stops sending. */
export const PARLUME_OUTLET_LEAD_MS = LEAD_FRAMES * FRAME_MS;
// After a longer stall the clock restarts with the lead restored, rather than
// sending the whole missed stretch at once.
const MAX_CATCH_UP_FRAMES = 5;
// On Teams the bot unmutes when audio arrives, which clips whatever it is
// playing at that moment; a reply that starts from idle opens with silence.
const PREROLL_MS = 300;
// A tail shorter than a frame waits for more speech; polling for it at the
// frame deadline, already past, would re-tick every millisecond.
const WAIT_FOR_AUDIO_MS = 20;
// A reply whose next audio is late is kept going with silence for up to 8 s:
// Attendee mutes the bot after 2 s without audio, mid-reply.
const MAX_GAP_FRAMES = 8_000 / FRAME_MS;

/**
 * Reads one reply's 24 kHz speech and hands it to `enqueue` as it arrives.
 * Returns false when the reply stopped being current first.
 */
export async function readParlumeSpeech(input: {
	body: ReadableStream<Uint8Array>;
	/** Bytes of speech the caller declared. */
	declaredLength: number | null;
	isCurrent: () => boolean;
	enqueue: (bytes: Uint8Array) => void;
}): Promise<boolean> {
	const reader = input.body.getReader();
	let total = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (!input.isCurrent()) {
				return false;
			}
			if (value) {
				total += value.byteLength;
				if (total > MAX_BYTES) {
					throw new Error("PCM limit exceeded");
				}
				input.enqueue(value);
			}
			if (done) {
				if (
					!total ||
					(input.declaredLength !== null &&
						input.declaredLength !== total)
				) {
					throw new Error("Invalid PCM length");
				}
				return true;
			}
		}
	} finally {
		await reader.cancel();
		reader.releaseLock();
	}
}

export function encodeParlumeBase64(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) {
		binary += String.fromCharCode(byte);
	}
	return btoa(binary);
}

/** One frame of speech as the message Attendee plays into the meeting. */
export function parlumeBotOutputMessage(
	frame: Uint8Array,
	sampleRate: number,
): string {
	return JSON.stringify({
		trigger: "realtime_audio.bot_output",
		data: { chunk: encodeParlumeBase64(frame), sample_rate: sampleRate },
	});
}

/** How one reply played: its covered waits, time it ran out, and clock restarts. */
interface ParlumeOutletReplyStats {
	/**
	 * Silence the outlet sent while the open reply waited for its next part,
	 * such as a tool call after "Let me check": planned, and heard as a pause.
	 */
	waitMs: number;
	/**
	 * Starvation: the time after the gap allowance ran out, when the bot may
	 * mute, until the next audio or the reply's end.
	 */
	underrunMs: number;
	stallResets: number;
}

function noReplyStats(): ParlumeOutletReplyStats {
	return { waitMs: 0, underrunMs: 0, stallResets: 0 };
}

/** One reply, from its first audio until it played out or was dropped. */
export interface ParlumeOutletReply extends ParlumeOutletReplyStats {
	/** It played to its end; false when `clear` dropped what was left. */
	played: boolean;
	/** From its first audio to its end. */
	speakingMs: number;
	/** The speech it was given, and how much of what it held `clear` dropped. */
	speechMs: number;
	droppedMs: number;
}

/** Told of each piece of speech the outlet queues, and of each reply's end. */
export interface ParlumeOutletReplyObserver {
	/** Speech was queued; `opened` when it opened a reply. */
	queued(opened: boolean): void;
	ended(reply: ParlumeOutletReply): void;
}

/**
 * The meeting bot's audio input for one connection. While a reply is queued
 * the outlet sends one 100 ms frame per 100 ms on an absolute clock, 200 ms
 * ahead, and between replies it sends nothing: Attendee queues every byte it
 * receives and cannot be told to drop it, so silence streamed ahead of time
 * would delay the next reply by as long as it ran. Replies wait here rather
 * than at the bot, so clearing the queue silences one within the 200 ms lead.
 *
 * A reply is open from its first audio until `end` has it played out, or
 * `clear` drops it. When its audio runs out while it is open, the outlet goes
 * on sending silence at the same pace, for up to `MAX_GAP_FRAMES`, so the bot
 * never sees its input stop inside a reply; the lead stays 200 ms, so a stop
 * is as fast as before. After a longer gap the next audio opens with silence,
 * as a reply from idle does.
 */
export class ParlumeAudioOutlet {
	readonly sampleRate: number;
	private readonly frameBytes: number;
	private readonly prerollBytes: number;
	private readonly send: (frame: Uint8Array) => void;
	private readonly now: () => number;
	private readonly schedule: (run: () => void, milliseconds: number) => void;
	private queue: Uint8Array[] = [];
	private offset = 0;
	private queuedBytes = 0;
	// Bytes ever queued, and ever sent or dropped: a drain waits for its own.
	private added = 0;
	private released = 0;
	private dropped = 0;
	private anchor = 0;
	private sent = 0;
	private speaking = false;
	private ending = false;
	private stopped = false;
	// Paused: nothing more is sent, and what is queued waits for `resume`.
	private held = false;
	// A tick is scheduled.
	private ticking = false;
	private open = false;
	// Silence frames sent since the open reply's audio last ran out.
	private gapFrames = 0;
	// When the open reply stopped getting silence, its gap too long.
	private quietSince: number | null = null;
	private stats: ParlumeOutletReplyStats = noReplyStats();
	// The open reply's first audio, the speech it was given, and the bytes
	// dropped before it opened.
	private openedAt = 0;
	private speechBytes = 0;
	private droppedBefore = 0;
	private readonly replies: ParlumeOutletReplyObserver | null;
	private drainWaiters: Array<{ until: number; release: () => void }> = [];

	constructor(options: {
		sampleRate: number;
		send: (frame: Uint8Array) => void;
		now?: () => number;
		schedule?: (run: () => void, milliseconds: number) => void;
		replies?: ParlumeOutletReplyObserver;
	}) {
		this.replies = options.replies ?? null;
		this.sampleRate = options.sampleRate;
		this.frameBytes = (options.sampleRate * 2 * FRAME_MS) / 1000;
		this.prerollBytes = (options.sampleRate * 2 * PREROLL_MS) / 1000;
		this.send = options.send;
		this.now = options.now ?? Date.now;
		this.schedule =
			options.schedule ??
			((run, milliseconds) => {
				setTimeout(run, milliseconds);
			});
	}

	stop(): void {
		this.stopped = true;
		this.clear();
	}

	enqueue(bytes: Uint8Array): void {
		if (bytes.length === 0 || this.stopped) {
			return;
		}
		const opening = !this.open;
		if (opening) {
			this.open = true;
			this.stats = noReplyStats();
			this.openedAt = this.now();
			this.speechBytes = 0;
			this.droppedBefore = this.dropped;
		}
		this.speechBytes += bytes.length;
		this.replies?.queued(opening);
		const starting = !this.speaking;
		if (starting) {
			this.start();
		}
		this.add(bytes);
		if (starting) {
			this.tick();
		}
	}

	/**
	 * Marks the queued reply complete. Until then a short tail waits for more
	 * audio instead of going out padded, which would put a gap mid-sentence.
	 */
	end(): void {
		this.ending = true;
		if (this.speaking || !this.open) {
			return;
		}
		// The reply went quiet in a long gap: what is left of it goes now.
		if (this.queuedBytes > 0) {
			this.start();
			this.tick();
			return;
		}
		this.close();
	}

	/** Bytes ever dropped by `clear` before they were sent. */
	get droppedBytes(): number {
		return this.dropped;
	}

	/** The current reply, or the latest one once it is over. */
	get replyStats(): ParlumeOutletReplyStats {
		return { ...this.stats };
	}

	/** A reply is open: it has queued audio and has not played out. */
	get inReply(): boolean {
		return this.open;
	}

	/**
	 * How much speech the bot holds that it has not played yet: the lead the
	 * outlet sent ahead of its clock.
	 */
	get leadMs(): number {
		if (!this.speaking || this.held) {
			return 0;
		}
		return Math.max(0, this.sent * FRAME_MS - (this.now() - this.anchor));
	}

	/**
	 * Speech is queued that the outlet can send: a tail shorter than a frame,
	 * still waiting for the rest of its reply, is not.
	 */
	get pending(): boolean {
		return (
			this.queuedBytes >= this.frameBytes ||
			(this.ending && this.queuedBytes > 0)
		);
	}

	/**
	 * Resolves once nothing is `pending`, speech queued meanwhile included,
	 * or the speech was cleared.
	 */
	async whenSent(): Promise<void> {
		while (this.pending) {
			const until =
				this.added -
				(this.ending ? 0 : this.queuedBytes % this.frameBytes);
			await new Promise<void>((release) =>
				this.drainWaiters.push({ until, release }),
			);
		}
	}

	/**
	 * Sends nothing more until `resume`: the bot plays out the lead it holds,
	 * and the queued speech waits, whole, to go on from where it stopped.
	 */
	pause(): void {
		if (!this.stopped) {
			this.held = true;
		}
	}

	/**
	 * Goes on with the speech `pause` held. After a gap the bot heard, it
	 * opens with silence again, as a reply from idle does, so the unmute that
	 * Teams makes does not clip it. `handOver` says the speech now goes to a
	 * socket that replaced the one it was sent to: that stream heard nothing
	 * of it, so it opens with silence however short the pause was.
	 */
	resume(handOver = false): void {
		if (!this.held) {
			return;
		}
		this.held = false;
		if (!this.speaking || (this.ticking && !handOver)) {
			return;
		}
		if (this.sent > 0) {
			this.prepend(new Uint8Array(this.prerollBytes));
		}
		this.anchor = this.now();
		this.sent = 0;
		// A tick still scheduled sends from the new clock.
		if (!this.ticking) {
			this.tick();
		}
	}

	/**
	 * Drops queued speech; anything waiting for it to drain is released. A
	 * pause ends with it: the next reply plays.
	 */
	clear(): void {
		this.dropped += this.queuedBytes;
		this.released += this.queuedBytes;
		this.endReply(false);
		this.queue = [];
		this.offset = 0;
		this.queuedBytes = 0;
		this.ending = false;
		this.held = false;
		this.open = false;
		this.quietSince = null;
		// Held, the outlet has no tick left to notice that it is idle.
		if (!this.ticking) {
			this.speaking = false;
		}
		this.releaseDrainWaiters();
	}

	/**
	 * Resolves once everything queued so far has been sent, or was cleared.
	 * Speech queued after the call is not waited for.
	 */
	drained(): Promise<void> {
		const until = this.added;
		if (this.released >= until) {
			return Promise.resolve();
		}
		return new Promise((release) =>
			this.drainWaiters.push({ until, release }),
		);
	}

	private add(bytes: Uint8Array): void {
		this.queue.push(bytes);
		this.queuedBytes += bytes.length;
		this.added += bytes.length;
	}

	// Ahead of what is queued, so a drain waits for these bytes too.
	private prepend(bytes: Uint8Array): void {
		const head = this.queue[0];
		if (head && this.offset > 0) {
			this.queue[0] = head.subarray(this.offset);
			this.offset = 0;
		}
		this.queue.unshift(bytes);
		this.queuedBytes += bytes.length;
		this.added += bytes.length;
		for (const waiter of this.drainWaiters) {
			waiter.until += bytes.length;
		}
	}

	// Starts sending, with the lead-in silence the bot's unmute needs.
	private start(): void {
		const now = this.now();
		if (this.quietSince !== null) {
			this.stats.underrunMs += now - this.quietSince;
			this.quietSince = null;
		}
		this.speaking = true;
		this.anchor = now;
		this.sent = 0;
		this.gapFrames = 0;
		this.prepend(new Uint8Array(this.prerollBytes));
	}

	private close(): void {
		this.endReply(true);
		this.speaking = false;
		this.ending = false;
		this.open = false;
		this.quietSince = null;
	}

	// The open reply is over: the time it went quiet counts as run out, and
	// the observer is told how it played.
	private endReply(played: boolean): void {
		if (!this.open) {
			return;
		}
		const now = this.now();
		if (this.quietSince !== null) {
			this.stats.underrunMs += now - this.quietSince;
			this.quietSince = null;
		}
		const bytesPerMs = (this.sampleRate * 2) / 1000;
		this.replies?.ended({
			...this.stats,
			played,
			speakingMs: now - this.openedAt,
			speechMs: Math.round(this.speechBytes / bytesPerMs),
			droppedMs: Math.round(
				(this.dropped - this.droppedBefore) / bytesPerMs,
			),
		});
	}

	private readonly tick = (): void => {
		this.ticking = false;
		if (
			this.stopped ||
			(this.queuedBytes === 0 && (!this.open || this.ending))
		) {
			this.close();
			return;
		}
		if (this.held) {
			return;
		}
		const now = this.now();
		let due =
			LEAD_FRAMES +
			Math.floor((now - this.anchor) / FRAME_MS) +
			1 -
			this.sent;
		if (due > MAX_CATCH_UP_FRAMES) {
			this.anchor = now - this.sent * FRAME_MS;
			due = LEAD_FRAMES + 1;
			this.stats.stallResets++;
		}
		let frame = 0;
		for (; frame < due && this.pending; frame++) {
			this.send(this.nextFrame());
			this.sent++;
			this.gapFrames = 0;
		}
		const waitingForAudio =
			this.queuedBytes < this.frameBytes && !this.ending;
		if (waitingForAudio) {
			for (; frame < due && this.gapFrames < MAX_GAP_FRAMES; frame++) {
				this.send(new Uint8Array(this.frameBytes));
				this.sent++;
				this.gapFrames++;
				this.stats.waitMs += FRAME_MS;
			}
			if (this.gapFrames >= MAX_GAP_FRAMES) {
				// The bot may mute now; the next audio unmutes it, so it
				// opens with silence (`start`).
				this.speaking = false;
				this.quietSince = now;
				return;
			}
		}
		const nextAt = this.anchor + (this.sent - LEAD_FRAMES) * FRAME_MS;
		this.ticking = true;
		this.schedule(
			this.tick,
			Math.max(waitingForAudio ? WAIT_FOR_AUDIO_MS : 1, nextAt - now),
		);
	};

	private nextFrame(): Uint8Array {
		const frame = new Uint8Array(this.frameBytes);
		let filled = 0;
		while (filled < this.frameBytes && this.queue.length > 0) {
			const head = this.queue[0];
			const take = Math.min(
				this.frameBytes - filled,
				head.length - this.offset,
			);
			frame.set(head.subarray(this.offset, this.offset + take), filled);
			filled += take;
			this.offset += take;
			this.queuedBytes -= take;
			this.released += take;
			if (this.offset === head.length) {
				this.queue.shift();
				this.offset = 0;
			}
		}
		this.releaseDrainWaiters();
		return frame;
	}

	private releaseDrainWaiters(): void {
		const waiters = this.drainWaiters;
		this.drainWaiters = waiters.filter(
			(waiter) => waiter.until > this.released,
		);
		for (const waiter of waiters) {
			if (waiter.until <= this.released) {
				waiter.release();
			}
		}
	}
}
