interface PcmConverter {
	push(chunk: Uint8Array): Uint8Array;
	flush(): Uint8Array;
}

// 24 kHz to 16 kHz is upsampling by two and keeping every third sample at
// 48 kHz. A windowed-sinc low-pass at 7 kHz, applied at 48 kHz, removes the
// 8-12 kHz band that would otherwise fold back into the speech as aliasing.
const HALF_TAPS = 48;
const LOW_PASS = (() => {
	const cutoff = 7_000 / 48_000;
	const taps = new Float64Array(2 * HALF_TAPS + 1);
	let sum = 0;
	for (let n = -HALF_TAPS; n <= HALF_TAPS; n++) {
		const x = 2 * cutoff * n;
		const sinc = n === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
		const blackman =
			0.42 +
			0.5 * Math.cos((Math.PI * n) / HALF_TAPS) +
			0.08 * Math.cos((2 * Math.PI * n) / HALF_TAPS);
		taps[n + HALF_TAPS] = sinc * blackman;
		sum += taps[n + HALF_TAPS];
	}
	// Zero-stuffing halves the energy each output draws on; restore unity gain.
	return taps.map((tap) => (tap * 2) / sum);
})();

/**
 * Converts streamed 24 kHz, 16-bit mono PCM to 16 kHz. Output sample k sits at
 * 48 kHz position 3k and the filter is centred on it, so the result is
 * time-aligned and exactly two thirds of the input's length.
 */
function createPcmDownsampler(): PcmConverter {
	let pending: number[] = [];
	let base = 0;
	let received = 0;
	let next = 0;
	let oddByte: number | null = null;

	const drain = (final: boolean): Uint8Array => {
		const out: number[] = [];
		const end = final
			? Math.ceil((2 * received) / 3)
			: Number.POSITIVE_INFINITY;
		while (next < end) {
			const centre = 3 * next;
			if (!final && Math.floor((centre + HALF_TAPS) / 2) >= received) {
				break;
			}
			let sum = 0;
			// Only even 48 kHz positions carry an input sample.
			for (
				let position = Math.max(0, centre - HALF_TAPS);
				position <= centre + HALF_TAPS;
				position++
			) {
				if (position % 2 !== 0) {
					continue;
				}
				const index = position / 2;
				if (index >= received) {
					break;
				}
				sum +=
					LOW_PASS[position - centre + HALF_TAPS] *
					pending[index - base];
			}
			out.push(Math.max(-32_768, Math.min(32_767, Math.round(sum))));
			next++;
		}
		const keepFrom = Math.max(0, Math.ceil((3 * next - HALF_TAPS) / 2));
		if (keepFrom > base) {
			pending = pending.slice(keepFrom - base);
			base = keepFrom;
		}
		const bytes = new Uint8Array(out.length * 2);
		const view = new DataView(bytes.buffer);
		for (const [index, sample] of out.entries()) {
			view.setInt16(index * 2, sample, true);
		}
		return bytes;
	};

	return {
		push(chunk) {
			let offset = 0;
			if (oddByte !== null && chunk.length > 0) {
				pending.push(((oddByte | (chunk[0] << 8)) << 16) >> 16);
				received++;
				oddByte = null;
				offset = 1;
			}
			for (; offset + 1 < chunk.length; offset += 2) {
				pending.push(
					((chunk[offset] | (chunk[offset + 1] << 8)) << 16) >> 16,
				);
				received++;
			}
			if (offset < chunk.length) {
				oddByte = chunk[offset];
			}
			return drain(false);
		},
		flush() {
			return drain(true);
		},
	};
}

// Fabric synthesizes speech as 24 kHz, 16-bit mono PCM.
const SPEECH_SAMPLE_RATE = 24_000;
const MAX_BYTES = 6 * 1024 * 1024;
const FRAME_MS = 20;
// Kept queued at the bot, so a late timer never leaves its sink without audio.
const LEAD_FRAMES = 5;
// After a longer stall the clock restarts with the lead restored, rather than
// sending the whole missed stretch at once.
const MAX_CATCH_UP_FRAMES = 10;

const PASS_THROUGH: PcmConverter = {
	push: (chunk) => chunk,
	flush: () => new Uint8Array(0),
};

/**
 * The bot plays exactly the rate it declared in its handshake, so speech is
 * converted to that rate here rather than wherever the bot was configured.
 * Returns null for a rate the bridge cannot produce.
 */
export function parlumePcmConverter(sampleRate: number): PcmConverter | null {
	if (sampleRate === SPEECH_SAMPLE_RATE) {
		return PASS_THROUGH;
	}
	if (sampleRate === 16_000) {
		return createPcmDownsampler();
	}
	return null;
}

/**
 * Reads one reply's 24 kHz speech, converts it, and hands it to `enqueue` as
 * it arrives. Returns false when the reply stopped being current first.
 */
export async function readParlumeSpeech(input: {
	body: ReadableStream<Uint8Array>;
	/** Bytes of 24 kHz speech the caller declared. */
	declaredLength: number | null;
	converter: PcmConverter;
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
				input.enqueue(input.converter.push(value));
			}
			if (done) {
				if (
					!total ||
					(input.declaredLength !== null &&
						input.declaredLength !== total)
				) {
					throw new Error("Invalid PCM length");
				}
				input.enqueue(input.converter.flush());
				return true;
			}
		}
	} finally {
		await reader.cancel();
		reader.releaseLock();
	}
}

/**
 * The meeting bot's audio input for one connection. While a reply is queued
 * the outlet sends one 20 ms frame per 20 ms on an absolute clock, 100 ms
 * ahead, and between replies it sends nothing: the bot buffers every byte it
 * receives, so silence streamed before it was admitted to the call came back
 * as a ~40 s delay. Replies wait here rather than at the bot, so clearing the
 * queue silences one within the 100 ms lead.
 */
export class ParlumeAudioOutlet {
	readonly sampleRate: number;
	private readonly frameBytes: number;
	private readonly send: (frame: Uint8Array) => void;
	private readonly now: () => number;
	private readonly schedule: (run: () => void, milliseconds: number) => void;
	private queue: Uint8Array[] = [];
	private offset = 0;
	private queuedBytes = 0;
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
		this.queue.push(bytes);
		this.queuedBytes += bytes.length;
		if (!this.speaking) {
			this.speaking = true;
			this.anchor = this.now();
			this.sent = 0;
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

	/** Drops queued speech; anything waiting for it to drain is released. */
	clear(): void {
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
		this.schedule(this.tick, Math.max(1, nextAt - now));
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
