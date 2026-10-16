import assert from "node:assert/strict";
import { test } from "node:test";
import {
	ParlumeAudioOutlet,
	parlumeBotOutputMessage,
	readParlumeSpeech,
} from "./parlume-pcm.ts";

// 100 ms of 24 kHz, 16-bit mono.
const FRAME_BYTES = 4_800;
const FRAME_MS = 100;
// The outlet keeps two frames (200 ms) queued at the bot.
const LEAD_FRAMES = 2;
// A reply from idle opens with 300 ms of silence.
const PREROLL_FRAMES = 3;

function outletHarness() {
	let clock = 0;
	let lateBy = 0;
	const timers: Array<{ at: number; run: () => void }> = [];
	const sent: Array<{ at: number; frame: Uint8Array }> = [];
	const delays: number[] = [];
	const outlet = new ParlumeAudioOutlet({
		sampleRate: 24_000,
		send: (frame) => sent.push({ at: clock, frame }),
		now: () => clock,
		schedule: (run, milliseconds) => {
			delays.push(milliseconds);
			timers.push({ at: clock + milliseconds, run });
		},
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
		delays,
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
const isSilence = (frame: Uint8Array) => frame.every((byte) => byte === 0);

test("sends nothing between replies", () => {
	const { sent, advance } = outletHarness();

	advance(5_000);

	assert.equal(sent.length, 0);
});

test("opens a reply with 300 ms of silence, then sends one 100 ms frame every 100 ms, 200 ms ahead, and goes idle after it", async () => {
	const { outlet, sent, advance } = outletHarness();

	outlet.enqueue(speech(20));
	const done = outlet.drained();
	advance(5_000);
	await done;

	assert.equal(sent.length, PREROLL_FRAMES + 20);
	for (const [index, { at, frame }] of sent.entries()) {
		assert.equal(at, Math.max(0, (index - LEAD_FRAMES) * FRAME_MS));
		assert.equal(frame.length, FRAME_BYTES);
		assert.equal(
			isSilence(frame),
			index < PREROLL_FRAMES,
			`frame ${index}`,
		);
	}
});

test("holds a short tail until the reply ends, then pads it to a whole frame", async () => {
	const { outlet, sent, advance } = outletHarness();

	outlet.enqueue(new Uint8Array(3 * FRAME_BYTES + 400).fill(7));
	const done = outlet.drained();
	advance(1_000);
	assert.equal(sent.length, PREROLL_FRAMES + 3);

	outlet.end();
	advance(2_000);
	await done;

	assert.equal(sent.length, PREROLL_FRAMES + 4);
	const last = sent[PREROLL_FRAMES + 3].frame;
	assert.ok(last.subarray(0, 400).every((byte) => byte === 7));
	assert.ok(last.subarray(400).every((byte) => byte === 0));
});

test("a tail shorter than a frame waits for more speech without polling every millisecond", async () => {
	const { outlet, sent, delays, advance } = outletHarness();

	outlet.enqueue(new Uint8Array(400).fill(7));
	const done = outlet.drained();
	advance(1_000);

	assert.equal(sent.length, PREROLL_FRAMES);
	assert.ok(sent.every(({ frame }) => isSilence(frame)));
	// One tick every 20 ms at most, not one per millisecond.
	assert.ok(delays.length <= 1_000 / 20 + 2, `${delays.length} ticks`);
	assert.ok(
		delays.every((milliseconds) => milliseconds >= 20),
		`shortest tick ${Math.min(...delays)} ms`,
	);

	outlet.end();
	advance(1_100);
	await done;

	assert.equal(sent.length, PREROLL_FRAMES + 1);
	const tail = sent[PREROLL_FRAMES].frame;
	assert.ok(tail.subarray(0, 400).every((byte) => byte === 7));
	assert.ok(tail.subarray(400).every((byte) => byte === 0));
	assert.ok(sent[PREROLL_FRAMES].at <= 1_020, "flushed on the next tick");
});

test("joins audio that arrives in pieces without gaps mid-reply", async () => {
	const { outlet, sent, advance } = outletHarness();

	outlet.enqueue(new Uint8Array(FRAME_BYTES + 100).fill(7));
	advance(400);
	outlet.enqueue(new Uint8Array(FRAME_BYTES - 100).fill(7));
	outlet.end();
	const done = outlet.drained();
	advance(2_000);
	await done;

	const reply = sent.slice(PREROLL_FRAMES);
	assert.equal(reply.length, 2);
	assert.ok(reply.every(({ frame }) => frame.every((byte) => byte === 7)));
});

test("a reply queued while another plays follows it without more silence", async () => {
	const { outlet, sent, advance } = outletHarness();

	outlet.enqueue(speech(5));
	advance(100);
	outlet.enqueue(speech(5));
	outlet.end();
	const done = outlet.drained();
	advance(5_000);
	await done;

	assert.equal(sent.length, PREROLL_FRAMES + 10);
	assert.equal(
		sent.filter(({ frame }) => isSilence(frame)).length,
		PREROLL_FRAMES,
	);
});

test("a reply after an idle gap starts with a fresh lead and its own lead-in silence", () => {
	const { outlet, sent, advance } = outletHarness();
	outlet.enqueue(speech(10));
	advance(5_000);
	const before = sent.length;

	outlet.enqueue(speech(10));

	const burst = sent.slice(before);
	assert.equal(burst.length, LEAD_FRAMES + 1);
	assert.ok(burst.every(({ frame }) => isSilence(frame)));
});

test("late timers never let the bot's sink run dry", () => {
	const { outlet, sent, advance, setLateBy } = outletHarness();
	setLateBy(60);

	outlet.enqueue(speech(30));
	advance(10_000);

	assert.equal(sent.length, PREROLL_FRAMES + 30);
	for (const [index, { at }] of sent.entries()) {
		// Frame n starts playing at n * 100 ms; it must already be there.
		assert.ok(at <= index * FRAME_MS, `frame ${index} sent late at ${at}`);
	}
});

test("a stall restores the lead instead of flooding the bot", () => {
	const { outlet, sent, advance, jump } = outletHarness();
	outlet.enqueue(speech(60));
	advance(500);
	const before = sent.length;

	jump(5_000);
	advance(5_100);

	const burst = sent.slice(before).filter(({ at }) => at === sent[before].at);
	assert.equal(burst.length, LEAD_FRAMES + 1);
});

test("clearing drops queued speech at once and releases anyone waiting", async () => {
	const { outlet, sent, advance } = outletHarness();
	outlet.enqueue(speech(20));
	const waiting = outlet.drained();
	const before = sent.length;

	outlet.clear();
	await waiting;
	advance(5_000);

	assert.equal(sent.length, before);
});

test("a stopped outlet sends nothing more", () => {
	const { outlet, sent, advance } = outletHarness();
	outlet.enqueue(speech(20));
	advance(500);
	const before = sent.length;

	outlet.stop();
	advance(5_000);

	assert.equal(sent.length, before);
});

test("wraps a frame as the message Attendee plays into the meeting", () => {
	const frame = new Uint8Array(FRAME_BYTES);
	for (let index = 0; index < frame.length; index++) {
		frame[index] = index % 251;
	}

	const message = JSON.parse(parlumeBotOutputMessage(frame, 24_000));

	assert.deepEqual(Object.keys(message), ["trigger", "data"]);
	assert.equal(message.trigger, "realtime_audio.bot_output");
	assert.equal(message.data.sample_rate, 24_000);
	assert.deepEqual(
		Array.from(Buffer.from(message.data.chunk, "base64")),
		Array.from(frame),
	);
});

function pcmOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
	return new ReadableStream({
		start(controller) {
			controller.enqueue(bytes);
			controller.close();
		},
	});
}

test("reads a reply and hands it on unchanged", async () => {
	const queued: Uint8Array[] = [];
	const reply = new Uint8Array(48_000).fill(3);

	const complete = await readParlumeSpeech({
		body: pcmOf(reply),
		declaredLength: 48_000,
		isCurrent: () => true,
		enqueue: (bytes) => {
			queued.push(bytes);
		},
	});

	assert.equal(complete, true);
	assert.equal(
		queued.reduce((total, bytes) => total + bytes.length, 0),
		48_000,
	);
	assert.ok(queued.every((bytes) => bytes.every((byte) => byte === 3)));
});

test("stops reading a reply that is no longer current", async () => {
	let queued = 0;

	const complete = await readParlumeSpeech({
		body: pcmOf(new Uint8Array(4_800)),
		declaredLength: null,
		isCurrent: () => false,
		enqueue: (bytes) => {
			queued += bytes.length;
		},
	});

	assert.equal(complete, false);
	assert.equal(queued, 0);
});

test("refuses a reply shorter than it declared", async () => {
	await assert.rejects(
		readParlumeSpeech({
			body: pcmOf(new Uint8Array(4_800)),
			declaredLength: 9_600,
			isCurrent: () => true,
			enqueue: () => {},
		}),
		/Invalid PCM length/,
	);
});
