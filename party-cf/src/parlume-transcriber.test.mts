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
