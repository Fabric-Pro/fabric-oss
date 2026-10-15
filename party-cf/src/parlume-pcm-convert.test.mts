import assert from "node:assert/strict";
import { test } from "node:test";
import { parlumePcmConverter } from "./parlume-pcm.ts";

function convert(sampleRate: number, chunks: Uint8Array[]): Int16Array {
	const converter = parlumePcmConverter(sampleRate);
	assert.ok(converter);
	const parts = [
		...chunks.map((chunk) => converter.push(chunk)),
		converter.flush(),
	];
	const bytes = new Uint8Array(
		parts.reduce((sum, part) => sum + part.length, 0),
	);
	let offset = 0;
	for (const part of parts) {
		bytes.set(part, offset);
		offset += part.length;
	}
	return new Int16Array(bytes.buffer);
}

function tone(hz: number, seconds: number, amplitude: number): Uint8Array {
	const samples = Int16Array.from(
		{ length: Math.round(24_000 * seconds) },
		(_, index) =>
			Math.round(
				amplitude * Math.sin((2 * Math.PI * hz * index) / 24_000),
			),
	);
	return new Uint8Array(samples.buffer);
}

function rms(samples: Int16Array): number {
	let sum = 0;
	for (const sample of samples) {
		sum += sample * sample;
	}
	return Math.sqrt(sum / samples.length);
}

test("passes speech through unchanged to a 24 kHz bot", () => {
	const input = tone(1_000, 0.1, 10_000);

	const out = convert(24_000, [input]);

	assert.deepEqual(new Uint8Array(out.buffer), input);
});

test("keeps the length, pitch and level of speech for a 16 kHz bot", () => {
	const out = convert(16_000, [tone(1_000, 0.5, 10_000)]);

	assert.equal(out.length, 8_000);
	const middle = out.subarray(1_000, 7_000);
	let crossings = 0;
	for (let index = 1; index < middle.length; index++) {
		if (middle[index - 1] < 0 !== middle[index] < 0) {
			crossings++;
		}
	}
	const hz = crossings / 2 / (middle.length / 16_000);
	assert.ok(Math.abs(hz - 1_000) < 5, `${hz} Hz`);
	const level = rms(middle);
	assert.ok(Math.abs(level - 10_000 / Math.SQRT2) < 50, `rms ${level}`);
});

test("filters out content above 8 kHz instead of folding it back as noise", () => {
	const out = convert(16_000, [tone(10_000, 0.5, 10_000)]);

	const level = rms(out.subarray(1_000, 7_000));
	assert.ok(level < 10_000 / Math.SQRT2 / 100, `rms ${level}`);
});

test("gives identical audio however the synthesis stream is chunked", () => {
	const input = tone(440, 0.3, 8_000);
	const pieces: Uint8Array[] = [];
	const sizes = [1, 3, 7, 1_001, 2, 4_095];
	for (let offset = 0, turn = 0; offset < input.length; turn++) {
		const size = sizes[turn % sizes.length];
		pieces.push(input.subarray(offset, offset + size));
		offset += size;
	}

	const whole = convert(16_000, [input]);
	const chunked = convert(16_000, pieces);

	assert.equal(chunked.length, 4_800);
	assert.deepEqual(Array.from(chunked), Array.from(whole));
});

test("has no converter for a rate the bridge cannot produce", () => {
	assert.equal(parlumePcmConverter(44_100), null);
});
