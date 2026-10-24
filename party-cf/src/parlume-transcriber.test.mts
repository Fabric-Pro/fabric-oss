import assert from "node:assert/strict";
import test from "node:test";
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

test("audio sent while connecting is forwarded once the stream opens", async () => {
	const socket = new FakeSocket();
	const { transcriber, statuses } = setup(async () => socket);
	transcriber.send(new ArrayBuffer(4_800), 1_000);
	transcriber.send(new ArrayBuffer(4_800), 1_100);
	await flush();
	transcriber.send(new ArrayBuffer(4_800), 1_200);
	assert.equal(socket.accepted, true);
	assert.deepEqual(socket.sent, [4_800, 4_800, 4_800]);
	assert.deepEqual(statuses, ["connected"]);
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

test("a failed connection backs off, and a dropped stream reconnects on new audio", async () => {
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
	assert.deepEqual(sockets[0]?.sent, [4_800, 4_800, 4_800]);

	sockets[0]?.emit("close", { code: 1011, reason: "upstream" });
	transcriber.send(new ArrayBuffer(4_800), 800);
	await flush();
	assert.equal(attempts, 3);
	assert.deepEqual(statuses, ["failed", "connected", "closed", "connected"]);

	transcriber.close();
	assert.equal(sockets[1]?.closed, true);
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
	sockets[0].emit("close", { code: 1011, reason: "upstream" });
	transcriber.send(new ArrayBuffer(2_560), 80_000);
	await flush();
	sockets[0].flux({ ...event, event: "EndOfTurn" });
	sockets[1].flux({ ...event, event: "EndOfTurn" });
	assert.deepEqual(transcripts, [
		{ text: "hello", isFinal: false, startMs: 51_000, endMs: 51_500 },
		{ text: "hello", isFinal: true, startMs: 81_000, endMs: 81_500 },
	]);
	transcriber.close();
});
