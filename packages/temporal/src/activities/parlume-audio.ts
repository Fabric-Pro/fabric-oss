/** The bridge plays 24 kHz, 16-bit, mono little-endian PCM. */
export const PARLUME_PCM_SAMPLE_RATE = 24_000;

function chunkId(bytes: Uint8Array, offset: number): string {
	return String.fromCharCode(...bytes.subarray(offset, offset + 4));
}

/**
 * Extract the PCM samples from a WAV file, accepting only the format the
 * bridge plays. Gateway speech returns a complete encoded file; OpenAI's WAV
 * output is already 24 kHz 16-bit mono, so this strips the header rather than
 * resampling. Anything else is refused instead of being played at the wrong
 * speed.
 */
export function pcmFromWav(bytes: Uint8Array): Uint8Array {
	if (
		bytes.length < 12 ||
		chunkId(bytes, 0) !== "RIFF" ||
		chunkId(bytes, 8) !== "WAVE"
	) {
		throw new Error("Speech audio is not a WAV file.");
	}
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	let offset = 12;
	let format: {
		audioFormat: number;
		channels: number;
		sampleRate: number;
		bitsPerSample: number;
	} | null = null;
	while (offset + 8 <= bytes.length) {
		const id = chunkId(bytes, offset);
		const size = view.getUint32(offset + 4, true);
		const body = offset + 8;
		if (id === "fmt ") {
			format = {
				audioFormat: view.getUint16(body, true),
				channels: view.getUint16(body + 2, true),
				sampleRate: view.getUint32(body + 4, true),
				bitsPerSample: view.getUint16(body + 14, true),
			};
		}
		if (id === "data") {
			if (
				!format ||
				format.audioFormat !== 1 ||
				format.channels !== 1 ||
				format.sampleRate !== PARLUME_PCM_SAMPLE_RATE ||
				format.bitsPerSample !== 16
			) {
				throw new Error(
					`Speech audio format is unsupported (${format ? `${format.sampleRate} Hz, ${format.channels} ch, ${format.bitsPerSample}-bit` : "no fmt chunk"}).`,
				);
			}
			// Streamed WAV headers may declare an unknown (maximal) data size.
			const end = Math.min(bytes.length, body + size);
			const pcm = bytes.subarray(body, end - ((end - body) % 2));
			if (pcm.length === 0) {
				throw new Error("Speech audio is empty.");
			}
			return pcm;
		}
		offset = body + size + (size % 2);
	}
	throw new Error("Speech audio has no data chunk.");
}
