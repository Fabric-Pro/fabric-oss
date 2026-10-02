import { describe, expect, it } from "vitest";
import { pcmFromWav } from "../parlume-audio";

function wav(options: {
	sampleRate?: number;
	channels?: number;
	bits?: number;
	samples: number[];
	extraChunk?: boolean;
	dataSize?: number;
}): Uint8Array {
	const pcm = new Uint8Array(new Int16Array(options.samples).buffer);
	const extra = options.extraChunk ? 12 : 0;
	const bytes = new Uint8Array(44 + extra + pcm.length);
	const view = new DataView(bytes.buffer);
	const ascii = (offset: number, text: string) => {
		for (let i = 0; i < text.length; i++) {
			bytes[offset + i] = text.charCodeAt(i);
		}
	};
	ascii(0, "RIFF");
	view.setUint32(4, bytes.length - 8, true);
	ascii(8, "WAVE");
	ascii(12, "fmt ");
	view.setUint32(16, 16, true);
	view.setUint16(20, 1, true);
	view.setUint16(22, options.channels ?? 1, true);
	view.setUint32(24, options.sampleRate ?? 24_000, true);
	view.setUint32(28, (options.sampleRate ?? 24_000) * 2, true);
	view.setUint16(32, 2, true);
	view.setUint16(34, options.bits ?? 16, true);
	let offset = 36;
	if (options.extraChunk) {
		ascii(offset, "LIST");
		view.setUint32(offset + 4, 4, true);
		offset += 12;
	}
	ascii(offset, "data");
	view.setUint32(offset + 4, options.dataSize ?? pcm.length, true);
	bytes.set(pcm, offset + 8);
	return bytes;
}

describe("pcmFromWav", () => {
	it("returns the samples of a 24 kHz 16-bit mono file", () => {
		const pcm = pcmFromWav(wav({ samples: [1, -1, 300] }));

		expect(Array.from(new Int16Array(pcm.slice().buffer))).toEqual([
			1, -1, 300,
		]);
	});

	it("skips unrelated chunks before the samples", () => {
		const pcm = pcmFromWav(wav({ samples: [5, 6], extraChunk: true }));

		expect(pcm.length).toBe(4);
	});

	it("tolerates a streamed header that declares an unknown data size", () => {
		const pcm = pcmFromWav(wav({ samples: [7, 8], dataSize: 0xffffffff }));

		expect(pcm.length).toBe(4);
	});

	it("refuses audio the bridge would play at the wrong speed or width", () => {
		expect(() =>
			pcmFromWav(wav({ samples: [1], sampleRate: 44_100 })),
		).toThrow("44100 Hz");
		expect(() => pcmFromWav(wav({ samples: [1], channels: 2 }))).toThrow(
			"2 ch",
		);
	});

	it("refuses non-WAV and empty audio", () => {
		expect(() => pcmFromWav(new Uint8Array([1, 2, 3]))).toThrow(
			"not a WAV file",
		);
		expect(() => pcmFromWav(wav({ samples: [] }))).toThrow("empty");
	});
});
