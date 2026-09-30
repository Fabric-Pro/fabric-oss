import assert from "node:assert/strict";
import { test } from "node:test";
import { playParlumePcm } from "./parlume-pcm.ts";

test("plays a first frame before synthesis finishes and preserves split samples", async () => {
	let controller!: ReadableStreamDefaultController<Uint8Array>;
	const body = new ReadableStream<Uint8Array>({
		start(value) {
			controller = value;
		},
	});
	let signalFirstFrame!: () => void;
	const firstFrame = new Promise<void>((resolve) => {
		signalFirstFrame = resolve;
	});
	const frames: Uint8Array[] = [];
	const result = playParlumePcm({
		body,
		declaredLength: null,
		isCurrent: () => true,
		pause: async () => {},
		send(frame) {
			frames.push(frame);
			signalFirstFrame();
		},
	});
	controller.enqueue(new Uint8Array(17).fill(1));
	controller.enqueue(new Uint8Array(1903).fill(2));
	await firstFrame;
	assert.equal(frames.length, 1);
	assert.equal(frames[0]?.length, 1920);
	controller.enqueue(new Uint8Array([3, 4]));
	controller.close();
	assert.equal((await result).played, true);
	assert.deepEqual(Array.from(frames[1] ?? []), [3, 4]);
});

test("stale synthesis emits no audio", async () => {
	const frames: Uint8Array[] = [];
	const result = await playParlumePcm({
		body: new ReadableStream({
			start(controller) {
				controller.enqueue(new Uint8Array(1920));
				controller.close();
			},
		}),
		declaredLength: null,
		isCurrent: () => false,
		send: (frame) => frames.push(frame),
	});
	assert.equal(result.interrupted, true);
	assert.equal(frames.length, 0);
});

test("barge-in stops playback before the next frame", async () => {
	let current = true;
	let frames = 0;
	const result = await playParlumePcm({
		body: new ReadableStream({
			start(controller) {
				controller.enqueue(new Uint8Array(5760));
				controller.close();
			},
		}),
		declaredLength: null,
		isCurrent: () => current,
		send() {
			frames++;
			current = false;
		},
		pause: async () => {},
	});
	assert.equal(result.interrupted, true);
	assert.equal(frames, 1);
});
