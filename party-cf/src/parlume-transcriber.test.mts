import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import {
	ParlumeTranscriber,
	type ParlumeTranscript,
	type ParlumeTranscriptionSocket,
} from "./parlume-transcriber.ts";

class FakeSocket implements ParlumeTranscriptionSocket {
	sent: number[] = [];
	accepted = false;
	closed = false;
	private listeners = new Map<string, ((event: never) => void)[]>();
	accept() {
		this.accepted = true;
	}
	send(data: ArrayBuffer) {
		this.sent.push(data.byteLength);
	}
	close() {
		this.closed = true;
	}
	addEventListener(type: string, listener: (event: never) => void) {
		this.listeners.set(type, [
			...(this.listeners.get(type) ?? []),
			listener,
		]);
	}
	emit(type: string, event: unknown) {
		for (const listener of this.listeners.get(type) ?? []) {
			listener(event as never);
		}
	}
	flux(event: Record<string, unknown>) {
		this.emit("message", { data: JSON.stringify(event) });
	}
}

function setup(connect: () => Promise<FakeSocket>) {
	const transcripts: ParlumeTranscript[] = [];
	const statuses: string[] = [];
	let now = 0;
	const transcriber = new ParlumeTranscriber({
		sampleRate: 16_000,
		connect,
		onTranscript: (transcript) => transcripts.push(transcript),
		onStatus: (status) => statuses.push(status),
		now: () => now,
	});
	return {
		transcriber,
		transcripts,
		statuses,
		advance: (ms: number) => {
			now += ms;
		},
	};
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

// The mock clock runs only timers already due when it ticks, and catching up
// schedules each next batch as it sends one.
function elapse(t: TestContext, ms: number) {
	for (let step = 0; step < ms; step++) {
		t.mock.timers.tick(1);
	}
}

test("audio held while connecting reaches the stream at three times real time, live audio queuing behind it", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const socket = new FakeSocket();
	const { transcriber, statuses } = setup(async () => socket);
	// 150 ms batches.
	transcriber.send(new ArrayBuffer(4_800), 1_000);
	transcriber.send(new ArrayBuffer(4_800), 1_150);
	await flush();
	transcriber.send(new ArrayBuffer(4_800), 1_300);
	assert.equal(socket.accepted, true);
	assert.deepEqual(statuses, ["connected"]);
	assert.deepEqual(socket.sent, [4_800]);
	elapse(t, 49);
	assert.deepEqual(socket.sent, [4_800]);
	elapse(t, 1);
	assert.deepEqual(socket.sent, [4_800, 4_800]);
	elapse(t, 50);
	assert.deepEqual(socket.sent, [4_800, 4_800, 4_800]);
	// Caught up: live audio goes straight through.
	transcriber.send(new ArrayBuffer(4_800), 1_450);
	assert.deepEqual(socket.sent, [4_800, 4_800, 4_800, 4_800]);
});

// The meeting bot sends nothing while it posts a chat message, and its next
// chunk is stamped where the meeting is by then.
test("a gap in the meeting audio keeps the stream hearing silence a second behind, and resumed audio lands where the meeting heard it", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const socket = new FakeSocket();
	const { transcriber, transcripts, advance } = setup(async () => socket);
	const quiet = (ms: number) => {
		for (let step = 0; step < ms; step++) {
			advance(1);
			t.mock.timers.tick(1);
		}
	};
	transcriber.send(new ArrayBuffer(2_560), 0);
	await flush();
	quiet(1_000);
	assert.deepEqual(socket.sent, [2_560]);
	// From 1 s on, 80 ms of silence each 80 ms, up to a second ago.
	quiet(7_000);
	assert.equal(socket.sent.length, 88);
	assert.equal(socket.closed, false);

	transcriber.send(new ArrayBuffer(2_560), 8_000);
	assert.equal(socket.sent.length, 89);
	// The 960 ms still missing go first, at three times real time.
	elapse(t, 330);
	assert.equal(socket.sent.length, 101);
	assert.ok(socket.sent.every((bytes) => bytes === 2_560));
	socket.flux({
		event: "EndOfTurn",
		turn_index: 0,
		audio_window_start: 8,
		audio_window_end: 8.08,
		transcript: "Parlume",
		words: [{ word: "Parlume", start: 8.01, end: 8.07 }],
	});
	assert.deepEqual(transcripts.at(-1), {
		text: "Parlume",
		isFinal: true,
		startMs: 8_010,
		endMs: 8_070,
	});
	transcriber.close();
});

test("a jump in the meeting clock too long to fill moves the timestamps after it", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const socket = new FakeSocket();
	const { transcriber, transcripts, advance } = setup(async () => socket);
	transcriber.send(new ArrayBuffer(2_560), 0);
	await flush();
	advance(60_000);
	transcriber.send(new ArrayBuffer(2_560), 60_000);
	// Two seconds of silence, then the audio after the jump.
	elapse(t, 700);
	assert.equal(socket.sent.length, 27);
	const word = (start: number) => ({
		event: "Update",
		turn_index: 0,
		audio_window_start: 0,
		audio_window_end: 3,
		transcript: "hello",
		words: [{ word: "hello", start, end: start + 0.04 }],
	});
	socket.flux(word(1));
	assert.equal(transcripts.at(-1)?.startMs, 1_000);
	socket.flux(word(2.1));
	assert.equal(transcripts.at(-1)?.startMs, 60_020);
	transcriber.close();
});

test("a meeting clock that drifts from the audio, with no pause in it, gets no silence", async () => {
	const socket = new FakeSocket();
	const { transcriber, transcripts } = setup(async () => socket);
	transcriber.send(new ArrayBuffer(2_560), 0);
	await flush();
	// Each batch stamped 50 ms later than the audio before it ends.
	for (let index = 1; index <= 10; index++) {
		transcriber.send(new ArrayBuffer(2_560), index * 130);
	}
	assert.equal(socket.sent.length, 11);
	socket.flux({
		event: "Update",
		turn_index: 0,
		audio_window_start: 0,
		audio_window_end: 1,
		transcript: "hello",
		words: [{ word: "hello", start: 0.81, end: 0.85 }],
	});
	// The audio at 800 ms was sent stamped 1,300 ms.
	assert.equal(transcripts.at(-1)?.startMs, 1_310);
	transcriber.close();
});

test("silence stops after thirty seconds without meeting audio", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const socket = new FakeSocket();
	const { transcriber, advance } = setup(async () => socket);
	const quiet = (ms: number) => {
		for (let step = 0; step < ms; step++) {
			advance(1);
			t.mock.timers.tick(1);
		}
	};
	transcriber.send(new ArrayBuffer(2_560), 0);
	await flush();
	quiet(35_000);
	const sent = socket.sent.length;
	assert.ok(sent > 300);
	quiet(5_000);
	assert.equal(socket.sent.length, sent);
	transcriber.close();
});

test("10 ms meeting chunks reach Flux as 80 ms batches stamped with their first chunk", async () => {
	const socket = new FakeSocket();
	const { transcriber, transcripts } = setup(async () => socket);
	// 10 ms at 16 kHz, 16-bit mono.
	for (let index = 0; index < 8; index++) {
		transcriber.send(new ArrayBuffer(320), 70_000 + index * 10);
	}
	await flush();
	for (let index = 8; index < 15; index++) {
		transcriber.send(new ArrayBuffer(320), 70_000 + index * 10);
	}

	assert.deepEqual(socket.sent, [2_560]);
	socket.flux({
		event: "StartOfTurn",
		turn_index: 0,
		audio_window_start: 0.5,
		audio_window_end: 0.6,
		transcript: "",
	});
	assert.equal(transcripts[0]?.startMs, 70_500);

	transcriber.send(new ArrayBuffer(320), 70_150);
	assert.deepEqual(socket.sent, [2_560, 2_560]);
});

test("Flux turns become partial and final transcripts on the audio clock", async () => {
	const socket = new FakeSocket();
	const { transcriber, transcripts } = setup(async () => socket);
	transcriber.send(new ArrayBuffer(4_800), 50_000);
	await flush();

	socket.flux({
		event: "StartOfTurn",
		turn_index: 0,
		audio_window_start: 1.0,
		audio_window_end: 1.2,
		transcript: "",
	});
	socket.flux({
		event: "Update",
		turn_index: 0,
		audio_window_start: 1.0,
		audio_window_end: 1.8,
		transcript: "Hey Fabric",
	});
	socket.flux({
		event: "Update",
		turn_index: 0,
		audio_window_start: 1.0,
		audio_window_end: 2.0,
		transcript: "",
	});
	socket.flux({
		event: "EndOfTurn",
		turn_index: 0,
		audio_window_start: 1.5,
		audio_window_end: 3.0,
		transcript: "Hey Fabric, what is the project?",
	});

	assert.deepEqual(transcripts, [
		{ text: "", isFinal: false, startMs: 51_000, endMs: 51_200 },
		{ text: "Hey Fabric", isFinal: false, startMs: 51_000, endMs: 51_800 },
		{
			text: "Hey Fabric, what is the project?",
			isFinal: true,
			startMs: 51_000,
			endMs: 53_000,
		},
	]);
});

test("a failed connection backs off, and a dropped stream reconnects on new audio", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const sockets: FakeSocket[] = [];
	let attempts = 0;
	const { transcriber, statuses, advance } = setup(async () => {
		attempts++;
		if (attempts === 1) {
			throw new Error(
				"Workers AI returned HTTP 503 instead of a transcription stream.",
			);
		}
		const socket = new FakeSocket();
		sockets.push(socket);
		return socket;
	});

	transcriber.send(new ArrayBuffer(4_800), 0);
	await flush();
	transcriber.send(new ArrayBuffer(4_800), 100);
	await flush();
	assert.equal(attempts, 1);

	advance(600);
	transcriber.send(new ArrayBuffer(4_800), 700);
	await flush();
	assert.equal(attempts, 2);
	elapse(t, 100);
	assert.deepEqual(sockets[0]?.sent, [4_800, 4_800, 4_800]);

	sockets[0]?.emit("close", { code: 1011, reason: "upstream" });
	transcriber.send(new ArrayBuffer(4_800), 800);
	await flush();
	assert.equal(attempts, 3);
	assert.deepEqual(statuses, ["failed", "connected", "closed", "connected"]);

	transcriber.close();
	assert.equal(sockets[1]?.closed, true);
});

test("a stream that drops mid-sentence replays that sentence to the next one, not the finished turns or the silence", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const sockets: FakeSocket[] = [];
	const { transcriber, transcripts } = setup(async () => {
		const socket = new FakeSocket();
		sockets.push(socket);
		return socket;
	});
	const sendUntil = (fromMs: number, toMs: number) => {
		for (let ms = fromMs; ms <= toMs; ms += 80) {
			transcriber.send(new ArrayBuffer(2_560), ms);
		}
	};
	sendUntil(0, 0);
	await flush();
	// Silence, then a turn Flux finishes at 10.9 s.
	sendUntil(80, 10_960);
	sockets[0]?.flux({
		event: "EndOfTurn",
		turn_index: 0,
		audio_window_start: 10,
		audio_window_end: 11,
		transcript: "We ship on Friday.",
		words: [{ word: "Friday", start: 10, end: 10.9 }],
	});
	// Silence, then a request from 12 s that is cut off at 14 s.
	sendUntil(11_040, 12_400);
	sockets[0]?.flux({
		event: "Update",
		turn_index: 1,
		audio_window_start: 12,
		audio_window_end: 12.5,
		transcript: "Hey Fabric",
		words: [{ word: "Fabric", start: 12, end: 12.4 }],
	});
	sendUntil(12_480, 14_000);
	sockets[0]?.emit("close", { code: 1011, reason: "" });

	sendUntil(14_080, 14_080);
	await flush();
	// From the end of the finished turn (10.88 s) to now: 41 batches, 3.28 s
	// of audio, sent in a third of that time.
	assert.equal(sockets[1]?.sent.length, 1);
	elapse(t, 1_000);
	assert.equal(sockets[1]?.sent.length, 38);
	elapse(t, 100);
	assert.equal(sockets[1]?.sent.length, 41);
	sockets[1]?.flux({
		event: "EndOfTurn",
		turn_index: 0,
		audio_window_start: 1,
		audio_window_end: 3.2,
		transcript: "Hey Fabric, what is the status?",
		words: [
			{ word: "Hey", start: 1.12, end: 1.3 },
			{ word: "status", start: 2.6, end: 3.12 },
		],
	});
	assert.deepEqual(transcripts.at(-1), {
		text: "Hey Fabric, what is the status?",
		isFinal: true,
		startMs: 12_000,
		endMs: 14_000,
	});
});

for (const initialEvent of ["Update", "StartOfTurn"]) {
	test(`word bounds replace a silent ${initialEvent} start and follow cumulative transcripts`, async () => {
		const socket = new FakeSocket();
		const { transcriber, transcripts } = setup(async () => socket);
		transcriber.send(new ArrayBuffer(2_560), 50_000);
		await flush();
		socket.flux({
			event: initialEvent,
			turn_index: 0,
			audio_window_start: 0,
			audio_window_end: 0.25,
			transcript: "",
		});
		const words = [
			{ word: "Hey", start: 21.1, end: 21.4 },
			{ word: "Fabric", start: 21.5, end: 22 },
		];
		socket.flux({
			event: "StartOfTurn",
			turn_index: 0,
			audio_window_start: 21,
			audio_window_end: 22.5,
			transcript: "Hey Fabric",
			words,
		});
		assert.deepEqual(transcripts.at(-1), {
			text: "Hey Fabric",
			isFinal: false,
			startMs: 71_100,
			endMs: 72_000,
		});
		for (const event of ["Update", "EndOfTurn"]) {
			socket.flux({
				event,
				turn_index: 0,
				audio_window_start: 23,
				audio_window_end: 24,
				transcript: "Hey Fabric, hello",
				words: [
					{ word: "Hey", start: 21.05, end: 21.4 },
					words[1],
					{ word: "hello", start: 22.5, end: 23.2 },
				],
			});
			assert.deepEqual(transcripts.at(-1), {
				text: "Hey Fabric, hello",
				isFinal: event === "EndOfTurn",
				startMs: 71_050,
				endMs: 73_200,
			});
		}
	});
}

test("missing or invalid word bounds retain the processed-window fallback", async (t) => {
	const invalidWords: [string, unknown][] = [
		["missing", undefined],
		["empty", []],
		["non-array", "not an array"],
		["null word", [null]],
		["string start", [{ start: "1", end: 2 }]],
		["missing end", [{ start: 1 }]],
		["negative start", [{ start: -1, end: 2 }]],
		["inverted interval", [{ start: 2, end: 1 }]],
		["beyond processed audio", [{ start: 1, end: 5 }]],
		[
			"unordered words",
			[
				{ start: 2, end: 2.5 },
				{ start: 1, end: 1.5 },
			],
		],
		[
			"unordered ends",
			[
				{ start: 1, end: 2.5 },
				{ start: 2, end: 2.2 },
			],
		],
		["null start", [{ start: null, end: 2 }]],
		["null end", [{ start: 1, end: null }]],
	];
	for (const [name, words] of invalidWords) {
		await t.test(name, async () => {
			const socket = new FakeSocket();
			const { transcriber, transcripts } = setup(async () => socket);
			transcriber.send(new ArrayBuffer(2_560), 50_000);
			await flush();
			socket.flux({
				event: "Update",
				turn_index: 0,
				audio_window_start: 1,
				audio_window_end: 2,
				transcript: "",
			});
			socket.flux({
				event: "EndOfTurn",
				turn_index: 0,
				audio_window_start: 2,
				audio_window_end: 3,
				transcript: "hello",
				words,
			});
			assert.deepEqual(transcripts, [
				{
					text: "hello",
					isFinal: true,
					startMs: 51_000,
					endMs: 53_000,
				},
			]);
		});
	}
});

test("word bounds accept stream zero without processed windows and reject overflowing timestamps", async () => {
	const socket = new FakeSocket();
	const { transcriber, transcripts } = setup(async () => socket);
	transcriber.send(new ArrayBuffer(2_560), 50_000);
	await flush();
	socket.flux({
		event: "EndOfTurn",
		transcript: "hello",
		words: [{ start: 0, end: 0.2 }],
	});
	assert.deepEqual(transcripts.pop(), {
		text: "hello",
		isFinal: true,
		startMs: 50_000,
		endMs: 50_200,
	});
	for (const interval of [
		'"start":1e400,"end":1e400',
		'"start":0,"end":1e400',
		`"start":0,"end":${Number.MAX_VALUE}`,
	]) {
		socket.emit("message", {
			data: `{"event":"EndOfTurn","transcript":"hello","words":[{${interval}}]}`,
		});
		assert.deepEqual(transcripts.pop(), {
			text: "hello",
			isFinal: true,
			startMs: 50_000,
			endMs: 50_000,
		});
	}
});

test("word bounds use each reconnected socket's first audio epoch", async () => {
	const sockets = [new FakeSocket(), new FakeSocket()];
	let index = 0;
	const { transcriber, transcripts } = setup(async () => sockets[index++]);
	transcriber.send(new ArrayBuffer(2_560), 50_000);
	await flush();
	const event = {
		event: "Update",
		turn_index: 0,
		audio_window_start: 0,
		audio_window_end: 2,
		transcript: "hello",
		words: [{ word: "hello", start: 1, end: 1.5 }],
	};
	sockets[0].flux(event);
	sockets[0].flux({ ...event, event: "EndOfTurn" });
	sockets[0].emit("close", { code: 1011, reason: "upstream" });
	transcriber.send(new ArrayBuffer(2_560), 80_000);
	await flush();
	sockets[0].flux({ ...event, event: "EndOfTurn" });
	sockets[1].flux({ ...event, event: "EndOfTurn" });
	assert.deepEqual(transcripts, [
		{ text: "hello", isFinal: false, startMs: 51_000, endMs: 51_500 },
		{ text: "hello", isFinal: true, startMs: 51_000, endMs: 51_500 },
		{ text: "hello", isFinal: true, startMs: 81_000, endMs: 81_500 },
	]);
	transcriber.close();
});
