import assert from "node:assert/strict";
import { test } from "node:test";
import {
	ParlumeAudioOutlet,
	parlumePcmConverter,
	readParlumeSpeech,
} from "./parlume-pcm.ts";

// 20 ms of 16 kHz, 16-bit mono.
const FRAME_BYTES = 640;
const FRAME_MS = 20;
// The outlet keeps five frames (100 ms) queued at the bot.
const LEAD_FRAMES = 5;

function outletHarness() {
	let clock = 0;
	let lateBy = 0;
	const timers: Array<{ at: number; run: () => void }> = [];
	const sent: Array<{ at: number; frame: Uint8Array }> = [];
	const outlet = new ParlumeAudioOutlet({
		sampleRate: 16_000,
		send: (frame) => sent.push({ at: clock, frame }),
		now: () => clock,
		schedule: (run, milliseconds) =>
			timers.push({ at: clock + milliseconds, run }),
	});
	const advance = (until: number) => {
		for (;;) {
			timers.sort((a, b) => a.at - b.at);
			const next = timers[0];
			if (!next || next.at > until) {
				break;
			}
			timers.shift();
			clock = Math.max(clock, next.at) + lateBy;
			next.run();
		}
		clock = Math.max(clock, until);
	};
	return {
		outlet,
		sent,
		advance,
		setLateBy: (milliseconds: number) => {
			lateBy = milliseconds;
		},
		jump: (milliseconds: number) => {
			clock += milliseconds;
		},
	};
}

const speech = (frames: number) => new Uint8Array(frames * FRAME_BYTES).fill(7);

test("sends nothing between replies", () => {
	const { sent, advance } = outletHarness();

	advance(1_000);

	assert.equal(sent.length, 0);
});

test("sends a reply 100 ms ahead, then one 20 ms frame every 20 ms, and goes idle after it", async () => {
	const { outlet, sent, advance } = outletHarness();

	outlet.enqueue(speech(50));
	const done = outlet.drained();
	advance(2_000);
	await done;

	assert.equal(sent.length, 50);
	for (const [index, { at, frame }] of sent.entries()) {
		assert.equal(at, Math.max(0, (index - LEAD_FRAMES) * FRAME_MS));
		assert.equal(frame.length, FRAME_BYTES);
	}
});

test("holds a short tail until the reply ends, then pads it to a whole frame", async () => {
	const { outlet, sent, advance } = outletHarness();

	outlet.enqueue(new Uint8Array(3 * FRAME_BYTES + 80).fill(7));
	const done = outlet.drained();
	advance(200);
	assert.equal(sent.length, 3);

	outlet.end();
	advance(400);
	await done;

	assert.equal(sent.length, 4);
	const last = sent[3].frame;
	assert.ok(last.subarray(0, 80).every((byte) => byte === 7));
	assert.ok(last.subarray(80).every((byte) => byte === 0));
});

test("joins audio that arrives in pieces without gaps mid-reply", async () => {
	const { outlet, sent, advance } = outletHarness();

	outlet.enqueue(new Uint8Array(FRAME_BYTES + 100).fill(7));
	advance(40);
	outlet.enqueue(new Uint8Array(FRAME_BYTES - 100).fill(7));
	outlet.end();
	const done = outlet.drained();
	advance(400);
	await done;

	assert.equal(sent.length, 2);
	assert.ok(sent.every(({ frame }) => frame.every((byte) => byte === 7)));
});

test("a reply after an idle gap starts with a fresh lead", () => {
	const { outlet, sent, advance } = outletHarness();
	outlet.enqueue(speech(10));
	advance(1_000);
	const before = sent.length;

	outlet.enqueue(speech(10));

	assert.equal(sent.length - before, LEAD_FRAMES + 1);
});

test("late timers never let the bot's sink run dry", () => {
	const { outlet, sent, advance, setLateBy } = outletHarness();
	setLateBy(15);

	outlet.enqueue(speech(100));
	advance(3_000);

	assert.equal(sent.length, 100);
	for (const [index, { at }] of sent.entries()) {
		// Frame n starts playing at n * 20 ms; it must already be there.
		assert.ok(at <= index * FRAME_MS, `frame ${index} sent late at ${at}`);
	}
});

test("a stall restores the lead instead of flooding the bot", () => {
	const { outlet, sent, advance, jump } = outletHarness();
	outlet.enqueue(speech(200));
	advance(100);
	const before = sent.length;

	jump(2_000);
	advance(2_100);

	const burst = sent.slice(before).filter(({ at }) => at === sent[before].at);
	assert.equal(burst.length, LEAD_FRAMES + 1);
});

test("clearing drops queued speech at once and releases anyone waiting", async () => {
	const { outlet, sent, advance } = outletHarness();
	outlet.enqueue(speech(50));
	const waiting = outlet.drained();
	const before = sent.length;

	outlet.clear();
	await waiting;
	advance(1_000);

	assert.equal(sent.length, before);
});

test("a stopped outlet sends nothing more", () => {
	const { outlet, sent, advance } = outletHarness();
	outlet.enqueue(speech(50));
	advance(100);
	const before = sent.length;

	outlet.stop();
	advance(1_000);

	assert.equal(sent.length, before);
});

function pcmOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
	return new ReadableStream({
		start(controller) {
			controller.enqueue(bytes);
			controller.close();
		},
	});
}

test("reads a reply and hands it on converted to the bot's rate", async () => {
	const converter = parlumePcmConverter(16_000);
	assert.ok(converter);
	let queued = 0;

	const complete = await readParlumeSpeech({
		// One second of 24 kHz speech.
		body: pcmOf(new Uint8Array(48_000)),
		declaredLength: 48_000,
		converter,
		isCurrent: () => true,
		enqueue: (bytes) => {
			queued += bytes.length;
		},
	});

	assert.equal(complete, true);
	assert.equal(queued, 32_000);
});

test("stops reading a reply that is no longer current", async () => {
	const converter = parlumePcmConverter(24_000);
	assert.ok(converter);
	let queued = 0;

	const complete = await readParlumeSpeech({
		body: pcmOf(new Uint8Array(4_800)),
		declaredLength: null,
		converter,
		isCurrent: () => false,
		enqueue: (bytes) => {
			queued += bytes.length;
		},
	});

	assert.equal(complete, false);
	assert.equal(queued, 0);
});

test("refuses a reply shorter than it declared", async () => {
	const converter = parlumePcmConverter(24_000);
	assert.ok(converter);

	await assert.rejects(
		readParlumeSpeech({
			body: pcmOf(new Uint8Array(4_800)),
			declaredLength: 9_600,
			converter,
			isCurrent: () => true,
			enqueue: () => {},
		}),
		/Invalid PCM length/,
	);
});
