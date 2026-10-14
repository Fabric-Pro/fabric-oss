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

// 40 ms frames at 24 kHz; the bot is fed 500 ms ahead, so the first thirteen
// frames go out at once and each later one leaves 500–520 ms buffered.
const FRAME_MS = 40;
const BURST_FRAMES = 13;
const MAX_LEAD_MS = 520;

function pcmOf(frames: number): ReadableStream<Uint8Array> {
	return new ReadableStream({
		start(controller) {
			controller.enqueue(new Uint8Array(frames * 1920));
			controller.close();
		},
	});
}

test("late timers never let the bot's buffer run dry", async () => {
	let clock = 0;
	const sentAt: number[] = [];
	const result = await playParlumePcm({
		body: pcmOf(50),
		declaredLength: null,
		isCurrent: () => true,
		now: () => clock,
		// Every timer fires 15 ms late.
		pause: async (milliseconds) => {
			clock += milliseconds + 15;
		},
		send: () => sentAt.push(clock),
	});
	assert.equal(result.played, true);
	assert.equal(sentAt.length, 50);
	assert.deepEqual(
		sentAt.slice(0, BURST_FRAMES),
		Array(BURST_FRAMES).fill(0),
	);
	for (const [index, at] of sentAt.entries()) {
		// The frame reaches the bot before it would play...
		assert.ok(at <= index * FRAME_MS, `frame ${index} late at ${at} ms`);
		// ...and never more than the lead ahead of it.
		assert.ok(
			index * FRAME_MS - at <= MAX_LEAD_MS,
			`frame ${index} too early`,
		);
	}
});

test("a synthesis stall restarts the lead instead of bursting the backlog", async () => {
	let clock = 0;
	const sentAt: number[] = [];
	let stalled = false;
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(new Uint8Array(1920));
		},
		async pull(controller) {
			if (stalled) {
				return;
			}
			stalled = true;
			await new Promise((resolve) => setTimeout(resolve, 0));
			clock += 2_000;
			controller.enqueue(new Uint8Array(30 * 1920));
			controller.close();
		},
	});
	const result = await playParlumePcm({
		body,
		declaredLength: null,
		isCurrent: () => true,
		now: () => clock,
		pause: async (milliseconds) => {
			clock += milliseconds;
		},
		send: () => sentAt.push(clock),
	});
	assert.equal(result.played, true);
	assert.equal(sentAt[0], 0);
	assert.equal(sentAt.filter((at) => at === 2_000).length, BURST_FRAMES);
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
