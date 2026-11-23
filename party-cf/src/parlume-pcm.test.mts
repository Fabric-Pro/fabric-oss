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
	// What the outlet told its observer: `queued` opened or not, and ends.
	const replies: Array<boolean | Record<string, unknown>> = [];
	const outlet = new ParlumeAudioOutlet({
		sampleRate: 24_000,
		send: (frame) => sent.push({ at: clock, frame }),
		now: () => clock,
		schedule: (run, milliseconds) => {
			delays.push(milliseconds);
			timers.push({ at: clock + milliseconds, run });
		},
		replies: {
			queued: (opened) => replies.push(opened),
			ended: (reply) => replies.push({ ...reply }),
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
		replies,
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
	outlet.end();
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

const voiced = <T extends { frame: Uint8Array }>(frames: T[]): T[] =>
	frames.filter(({ frame }) => !isSilence(frame));

// The bot hears silence meanwhile (see the gap tests below), never a tail
// padded mid-sentence.
test("holds a short tail until the reply ends, then pads it to a whole frame", async () => {
	const { outlet, sent, advance } = outletHarness();

	outlet.enqueue(new Uint8Array(3 * FRAME_BYTES + 400).fill(7));
	const done = outlet.drained();
	advance(1_000);
	assert.equal(voiced(sent).length, 3);

	outlet.end();
	advance(2_000);
	await done;

	const reply = voiced(sent);
	assert.equal(reply.length, 4);
	const last = reply[3].frame;
	assert.ok(last.subarray(0, 400).every((byte) => byte === 7));
	assert.ok(last.subarray(400).every((byte) => byte === 0));
});

test("a tail shorter than a frame waits for more speech without polling every millisecond", async () => {
	const { outlet, sent, delays, advance } = outletHarness();

	outlet.enqueue(new Uint8Array(400).fill(7));
	const done = outlet.drained();
	advance(1_000);

	assert.ok(sent.length >= PREROLL_FRAMES);
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

	const reply = voiced(sent);
	assert.equal(reply.length, 1);
	const tail = reply[0].frame;
	assert.ok(tail.subarray(0, 400).every((byte) => byte === 7));
	assert.ok(tail.subarray(400).every((byte) => byte === 0));
	assert.ok(reply[0].at <= 1_100, "flushed on the next frame's tick");
});

test("joins audio that arrives in pieces without padding a piece", async () => {
	const { outlet, sent, advance } = outletHarness();

	outlet.enqueue(new Uint8Array(FRAME_BYTES + 100).fill(7));
	advance(400);
	outlet.enqueue(new Uint8Array(FRAME_BYTES - 100).fill(7));
	outlet.end();
	const done = outlet.drained();
	advance(2_000);
	await done;

	const reply = voiced(sent);
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

// A response's spoken time was taken when the next response had played too.
test("a drain waits for the speech queued before it, not for a reply queued after it", async () => {
	const { outlet, sent, advance } = outletHarness();
	outlet.enqueue(speech(5));
	outlet.end();
	let drained = false;
	void outlet.drained().then(() => {
		drained = true;
	});
	outlet.enqueue(speech(20));

	// Frame n goes out at (n - 2) * 100 ms; the first reply ends with frame 7.
	advance(400);
	await Promise.resolve();
	assert.equal(drained, false);

	advance(500);
	await Promise.resolve();
	assert.equal(drained, true);
	assert.ok(
		sent.length < PREROLL_FRAMES + 25,
		"the second reply still plays",
	);
});

test("a reply after an idle gap starts with a fresh lead and its own lead-in silence", () => {
	const { outlet, sent, advance } = outletHarness();
	outlet.enqueue(speech(10));
	outlet.end();
	advance(5_000);
	const before = sent.length;

	outlet.enqueue(speech(10));

	const burst = sent.slice(before);
	assert.equal(burst.length, LEAD_FRAMES + 1);
	assert.ok(burst.every(({ frame }) => isSilence(frame)));
});

test("a gap inside an open reply is filled with paced silence, and the reply goes on without lead-in silence", () => {
	const { outlet, sent, advance } = outletHarness();
	outlet.enqueue(speech(5));
	// The reply's audio runs out at 500 ms; the rest of it comes 3 s later.
	advance(3_500);
	const gap = sent.slice(PREROLL_FRAMES + 5);
	assert.equal(gap.length, 30);
	assert.ok(gap.every(({ frame }) => isSilence(frame)));
	for (const [index, { at }] of gap.entries()) {
		assert.equal(at, 600 + index * FRAME_MS, "one frame per 100 ms");
	}
	const before = sent.length;

	outlet.enqueue(numberedSpeech(5));
	outlet.end();
	advance(10_000);

	const after = sent.slice(before);
	assert.deepEqual(
		after.map(({ frame }) => frame[0]),
		[1, 2, 3, 4, 5],
		"no lead-in silence before the rest of the reply",
	);
	// A covered wait, such as a tool call mid-reply, is no starvation.
	assert.equal(outlet.replyStats.waitMs, 3_000);
	assert.equal(outlet.replyStats.underrunMs, 0);
});

test("a gap between replies sends nothing", () => {
	const { outlet, sent, advance } = outletHarness();
	outlet.enqueue(speech(5));
	outlet.end();
	advance(1_000);
	const before = sent.length;

	advance(10_000);

	assert.equal(before, PREROLL_FRAMES + 5);
	assert.equal(sent.length, before);
});

test("a gap longer than 8 s stops the silence, and the next audio opens with lead-in silence", () => {
	const { outlet, sent, advance } = outletHarness();
	outlet.enqueue(speech(5));
	advance(10_000);
	const gap = sent.slice(PREROLL_FRAMES + 5);
	assert.equal(gap.length, 80, "8 s of silence");
	const before = sent.length;

	advance(12_000);
	assert.equal(sent.length, before, "nothing after the 8 s");

	outlet.enqueue(numberedSpeech(5));
	outlet.end();
	advance(20_000);

	const after = sent.slice(before);
	assert.equal(after.length, PREROLL_FRAMES + 5);
	assert.ok(
		after.slice(0, PREROLL_FRAMES).every(({ frame }) => isSilence(frame)),
	);
	// 8 s of silence frames, then 3.5 s quiet, the bot muted, until 12 s.
	assert.equal(outlet.replyStats.waitMs, 8_000);
	assert.equal(outlet.replyStats.underrunMs, 3_500);
});

test("a reply that ends after its gap went quiet still flushes its tail", async () => {
	const { outlet, sent, advance } = outletHarness();
	outlet.enqueue(new Uint8Array(FRAME_BYTES + 400).fill(7));
	const done = outlet.drained();
	advance(10_000);
	assert.equal(voiced(sent).length, 1);

	outlet.end();
	advance(12_000);
	await done;

	assert.equal(voiced(sent).length, 2);
});

test("a paused outlet sends no silence through a gap", () => {
	const { outlet, sent, advance } = outletHarness();
	outlet.enqueue(speech(5));
	advance(1_500);
	outlet.pause();
	const before = sent.length;

	advance(6_000);

	assert.equal(sent.length, before);
});

test("counts each reply's stall resets, and starts over for the next reply", () => {
	const { outlet, advance, jump } = outletHarness();
	outlet.enqueue(speech(60));
	advance(500);
	jump(5_000);
	advance(5_600);
	assert.equal(outlet.replyStats.stallResets, 1);
	assert.equal(outlet.replyStats.underrunMs, 0);

	outlet.end();
	advance(20_000);
	outlet.enqueue(speech(5));

	assert.deepEqual(outlet.replyStats, {
		waitMs: 0,
		underrunMs: 0,
		stallResets: 0,
	});
});

test("whenSent waits for the speech it can send, not for a tail waiting for more", async () => {
	const { outlet, advance } = outletHarness();
	outlet.enqueue(new Uint8Array(2 * FRAME_BYTES + 400).fill(7));
	assert.equal(outlet.pending, true);
	let sentAll = false;
	void outlet.whenSent().then(() => {
		sentAll = true;
	});
	outlet.enqueue(speech(3));

	advance(400);
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(sentAll, false, "speech queued meanwhile is waited for too");

	advance(1_000);
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(sentAll, true);
	assert.equal(outlet.pending, false);
});

test("late timers never let the bot's sink run dry", () => {
	const { outlet, sent, advance, setLateBy } = outletHarness();
	setLateBy(60);

	outlet.enqueue(speech(30));
	outlet.end();
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

// Frame `index` of a reply carries `index + 1`, so the order it is heard in shows.
function numberedSpeech(frames: number): Uint8Array {
	const bytes = new Uint8Array(frames * FRAME_BYTES);
	for (let index = 0; index < frames; index++) {
		bytes.fill(index + 1, index * FRAME_BYTES, (index + 1) * FRAME_BYTES);
	}
	return bytes;
}

test("a pause sends nothing more, and a resume goes on with the same speech after lead-in silence", () => {
	const { outlet, sent, advance } = outletHarness();
	outlet.enqueue(numberedSpeech(20));
	advance(500);
	const before = sent.length;

	outlet.pause();
	advance(2_500);
	assert.equal(sent.length, before, "nothing is sent while paused");

	outlet.resume();
	advance(6_000);

	const resumed = sent.slice(before);
	assert.ok(
		resumed.slice(0, PREROLL_FRAMES).every(({ frame }) => isSilence(frame)),
		"the bot heard a gap, so the speech opens with silence again",
	);
	const heard = sent
		.filter(({ frame }) => !isSilence(frame))
		.map(({ frame }) => frame[0]);
	assert.deepEqual(
		heard,
		Array.from({ length: 20 }, (_, index) => index + 1),
		"every frame is heard once, in order",
	);
});

test("a drain waits through a pause for the speech it holds", async () => {
	const { outlet, advance } = outletHarness();
	outlet.enqueue(speech(10));
	outlet.end();
	let drained = false;
	void outlet.drained().then(() => {
		drained = true;
	});
	advance(300);

	outlet.pause();
	advance(5_000);
	await Promise.resolve();
	assert.equal(drained, false);

	outlet.resume();
	advance(10_000);
	await Promise.resolve();
	assert.equal(drained, true);
});

test("clearing a paused outlet drops its speech, and the next reply plays", () => {
	const { outlet, sent, advance } = outletHarness();
	outlet.enqueue(speech(20));
	advance(300);
	outlet.pause();
	advance(1_000);

	outlet.clear();
	outlet.resume();
	const before = sent.length;
	outlet.enqueue(speech(5));
	outlet.end();
	advance(3_000);

	assert.equal(sent.length - before, PREROLL_FRAMES + 5);
});

test("a resume without a pause sends nothing", () => {
	const { outlet, sent, advance } = outletHarness();
	outlet.enqueue(speech(5));
	outlet.end();
	advance(5_000);
	const before = sent.length;

	outlet.resume();
	advance(10_000);

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

test("tells its observer when speech opens a reply, and how each reply played or was dropped", () => {
	const { outlet, replies, advance } = outletHarness();
	outlet.enqueue(speech(5));
	outlet.enqueue(speech(5));
	outlet.end();
	advance(5_000);
	outlet.enqueue(speech(10));
	advance(5_300);
	outlet.clear();

	assert.deepEqual(replies, [
		true,
		false,
		{
			waitMs: 0,
			underrunMs: 0,
			stallResets: 0,
			played: true,
			// Its last frame went at 1 s; the next tick found it played out.
			speakingMs: 1_100,
			speechMs: 1_000,
			droppedMs: 0,
		},
		true,
		{
			waitMs: 0,
			underrunMs: 0,
			stallResets: 0,
			played: false,
			speakingMs: 300,
			speechMs: 1_000,
			// 300 ms of its speech was sent; the rest was dropped.
			droppedMs: 700,
		},
	]);
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
