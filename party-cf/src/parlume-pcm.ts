const FRAME_BYTES = 1_920;
const MAX_BYTES = 6 * 1024 * 1024;

export async function playParlumePcm(input: {
	body: ReadableStream<Uint8Array>;
	isCurrent: () => boolean;
	send: (frame: Uint8Array) => void;
	declaredLength: number | null;
	pause?: (milliseconds: number) => Promise<void>;
}): Promise<{ played: boolean; interrupted: boolean; firstAudioAt?: number }> {
	const reader = input.body.getReader();
	const pause =
		input.pause ??
		((milliseconds) =>
			new Promise((resolve) => setTimeout(resolve, milliseconds)));
	let pending = new Uint8Array(0);
	let total = 0;
	let firstAudioAt: number | undefined;
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
				firstAudioAt ??= Date.now();
				await pause((frame.length / 48_000) * 1000);
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
