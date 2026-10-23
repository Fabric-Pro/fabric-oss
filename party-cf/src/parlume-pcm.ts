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
// After a longer stall the clock restarts with the lead restored, rather than
// sending the whole missed stretch at once.
const MAX_CATCH_UP_FRAMES = 5;
// On Teams the bot unmutes when audio arrives, which clips whatever it is
// playing at that moment; a reply that starts from idle opens with silence.
const PREROLL_MS = 300;
// A tail shorter than a frame waits for more speech; polling for it at the
// frame deadline, already past, would re-tick every millisecond.
const WAIT_FOR_AUDIO_MS = 20;

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

/**
 * The meeting bot's audio input for one connection. While a reply is queued
 * the outlet sends one 100 ms frame per 100 ms on an absolute clock, 200 ms
 * ahead, and between replies it sends nothing: Attendee queues every byte it
 * receives and cannot be told to drop it, so silence streamed ahead of time
 * would delay the next reply by as long as it ran. Replies wait here rather
 * than at the bot, so clearing the queue silences one within the 200 ms lead.
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
	private dropped = 0;
	private anchor = 0;
	private sent = 0;
	private speaking = false;
	private ending = false;
	private stopped = false;
	private drainWaiters: Array<() => void> = [];

	constructor(options: {
		sampleRate: number;
		send: (frame: Uint8Array) => void;
		now?: () => number;
		schedule?: (run: () => void, milliseconds: number) => void;
	}) {
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
		const starting = !this.speaking;
		if (starting) {
			this.speaking = true;
			this.anchor = this.now();
			this.sent = 0;
			this.add(new Uint8Array(this.prerollBytes));
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
	}

	/** Bytes ever dropped by `clear` before they were sent. */
	get droppedBytes(): number {
		return this.dropped;
	}

	/** Drops queued speech; anything waiting for it to drain is released. */
	clear(): void {
		this.dropped += this.queuedBytes;
		this.queue = [];
		this.offset = 0;
		this.queuedBytes = 0;
		this.ending = false;
		this.releaseDrainWaiters();
	}

	/** Resolves once everything queued so far has been sent, or was cleared. */
	drained(): Promise<void> {
		if (this.queuedBytes === 0) {
			return Promise.resolve();
		}
		return new Promise((resolve) => this.drainWaiters.push(resolve));
	}

	private add(bytes: Uint8Array): void {
		this.queue.push(bytes);
		this.queuedBytes += bytes.length;
	}

	private readonly tick = (): void => {
		if (this.stopped || this.queuedBytes === 0) {
			this.speaking = false;
			this.ending = false;
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
		}
		for (
			let frame = 0;
			frame < due &&
			(this.queuedBytes >= this.frameBytes ||
				(this.ending && this.queuedBytes > 0));
			frame++
		) {
			this.send(this.nextFrame());
			this.sent++;
		}
		const nextAt = this.anchor + (this.sent - LEAD_FRAMES) * FRAME_MS;
		const waitingForAudio =
			this.queuedBytes < this.frameBytes && !this.ending;
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
			if (this.offset === head.length) {
				this.queue.shift();
				this.offset = 0;
			}
		}
		if (this.queuedBytes === 0) {
			this.releaseDrainWaiters();
		}
		return frame;
	}

	private releaseDrainWaiters(): void {
		const waiters = this.drainWaiters;
		this.drainWaiters = [];
		for (const release of waiters) {
			release();
		}
	}
}
