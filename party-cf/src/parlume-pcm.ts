const FRAME_BYTES = 1_920;
const MAX_BYTES = 6 * 1024 * 1024;
// 24 kHz, 16-bit mono.
const BYTES_PER_MS = 48;
// The bot plays what it has buffered and goes silent the moment the buffer
// runs dry, so a reply paced at exactly real time stutters on every late
// frame. Staying this far ahead absorbs network and timer jitter while
// keeping barge-in quick: at most this much audio plays after an interrupt.
const LEAD_MS = 500;

export async function playParlumePcm(input: {
	body: ReadableStream<Uint8Array>;
	isCurrent: () => boolean;
	send: (frame: Uint8Array) => void;
	declaredLength: number | null;
	pause?: (milliseconds: number) => Promise<void>;
	now?: () => number;
}): Promise<{ played: boolean; interrupted: boolean; firstAudioAt?: number }> {
	const reader = input.body.getReader();
	const pause =
		input.pause ??
		((milliseconds) =>
			new Promise((resolve) => setTimeout(resolve, milliseconds)));
	const now = input.now ?? Date.now;
	let pending = new Uint8Array(0);
	let total = 0;
	let firstAudioAt: number | undefined;
	// When the bot finishes playing everything sent so far. Pacing against
	// this absolute clock, rather than sleeping a frame's length after each
	// send, keeps late timers from accumulating into gaps.
	let playsUntil = 0;
	try {
		while (input.isCurrent()) {
			const { done, value } = await reader.read();
			if (!input.isCurrent()) {
				break;
			}
			if (value) {
				total += value.byteLength;
				if (total > MAX_BYTES) {
					throw new Error("PCM limit exceeded");
				}
				const next = new Uint8Array(pending.length + value.length);
				next.set(pending);
				next.set(value, pending.length);
				pending = next;
			}
			let consumed = 0;
			while (
				pending.length - consumed >= FRAME_BYTES ||
				(done && pending.length > consumed)
			) {
				if (!input.isCurrent()) {
					break;
				}
				const frame = pending.slice(consumed, consumed + FRAME_BYTES);
				if (frame.length % 2 !== 0) {
					throw new Error("Invalid PCM sample boundary");
				}
				consumed += frame.length;
				input.send(frame);
				const sentAt = now();
				firstAudioAt ??= sentAt;
				// A drained buffer (synthesis stalled) restarts from now.
				playsUntil =
					Math.max(playsUntil, sentAt) + frame.length / BYTES_PER_MS;
				const ahead = playsUntil - sentAt - LEAD_MS;
				if (ahead > 0) {
					await pause(ahead);
				}
			}
			pending = pending.slice(consumed);
			if (done && input.isCurrent()) {
				if (
					!total ||
					(input.declaredLength !== null &&
						input.declaredLength !== total)
				) {
					throw new Error("Invalid PCM length");
				}
				return { played: true, interrupted: false, firstAudioAt };
			}
		}
		return { played: false, interrupted: true, firstAudioAt };
	} finally {
		await reader.cancel();
		reader.releaseLock();
	}
}
