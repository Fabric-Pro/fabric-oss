import assert from "node:assert/strict";
import test from "node:test";
import { loadParlumeModule } from "./parlume-test-runtime.mts";

class FakeFlux {
	accepted = false;
	sent: number[] = [];
	private listeners = new Map<string, ((event: unknown) => void)[]>();
	accept() {
		this.accepted = true;
	}
	send(data: ArrayBuffer) {
		this.sent.push(data.byteLength);
	}
	close() {}
	addEventListener(type: string, listener: (event: unknown) => void) {
		this.listeners.set(type, [
			...(this.listeners.get(type) ?? []),
			listener,
		]);
	}
	turn(event: Record<string, unknown>) {
		for (const listener of this.listeners.get("message") ?? []) {
			listener({ data: JSON.stringify(event) });
		}
	}
}

type Bridge = {
	onStart(): Promise<void>;
	onConnect(conn: unknown, ctx: { request: { url: string } }): Promise<void>;
	onMessage(conn: unknown, message: string | ArrayBuffer): Promise<void>;
	onRequest(request: Request): Promise<Response>;
};

function meeting() {
	const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
	const fetch = async (url: unknown, init: unknown) => {
		const path = new URL(String(url)).pathname;
		const body = JSON.parse(String((init as RequestInit).body));
		requests.push({ path, body });
		if (path.endsWith("/verify-stream")) {
			return Response.json({
				valid: true,
				hardStopAt: new Date(Date.now() + 3_600_000).toISOString(),
				streamGeneration: 1,
			});
		}
		return Response.json({ accepted: true });
	};
	const data = new Map<string, unknown>();
	const storage = {
		get: async (key: string) => data.get(key),
		put: async (key: string | Record<string, unknown>, value?: unknown) => {
			if (typeof key === "string") {
				data.set(key, value);
			} else {
				for (const [k, v] of Object.entries(key)) {
					data.set(k, v);
				}
			}
		},
		delete: async (key: string) => data.delete(key),
		setAlarm: async () => {},
	};
	const flux = new FakeFlux();
	const transcription: Array<{
		model: string;
		inputs: unknown;
		options: unknown;
	}> = [];
	const { Parlume } = loadParlumeModule("./parlume.ts", fetch) as {
		Parlume: new (ctx: unknown, env: unknown) => Bridge;
	};
	const bridge = new Parlume(
		{ storage },
		{
			FABRIC_API_URL: "https://fabric.example",
			AGENT_SERVICE_SECRET: "service-secret",
			AI: {
				run: async (
					model: string,
					inputs: unknown,
					options: unknown,
				) => {
					transcription.push({ model, inputs, options });
					return { status: 101, webSocket: flux };
				},
			},
		},
	);
	const frames: number[] = [];
	const bot = {
		send: (frame: Uint8Array) => frames.push(frame.byteLength),
		close: () => {},
	};
	return { bridge, bot, flux, frames, requests, transcription };
}

// Objects built inside the sandboxed bridge have that realm's prototypes.
const plain = (value: unknown) => JSON.parse(JSON.stringify(value));
const flush = () => new Promise((resolve) => setImmediate(resolve));
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("the bot's audio is transcribed, attributed, and a woken request reaches Fabric", async () => {
	const { bridge, bot, flux, requests, transcription } = meeting();
	await bridge.onStart();
	await bridge.onConnect(bot, {
		request: {
			url: "wss://bridge.example.com/parties/parlume/session-1?token=stream-token",
		},
	});
	await bridge.onMessage(
		bot,
		JSON.stringify({
			protocol_version: 1,
			bot_id: "bot-1",
			offset: 0,
			sample_rate: 24_000,
			start_time: 1_000_000,
		}),
	);
	await bridge.onMessage(
		bot,
		JSON.stringify([
			{ name: "Dev One", id: 1, timestamp: 1_000_400, isSpeaking: true },
		]),
	);
	await bridge.onMessage(bot, new ArrayBuffer(4_800));
	await flush();

	assert.deepEqual(
		requests.find((r) => r.path.endsWith("/verify-stream"))?.body,
		{ sessionId: "session-1", streamToken: "stream-token", botId: "bot-1" },
	);
	assert.equal(transcription[0]?.model, "@cf/deepgram/flux");
	assert.deepEqual(plain(transcription[0]?.options), { websocket: true });
	assert.deepEqual(plain(transcription[0]?.inputs), {
		encoding: "linear16",
		sample_rate: "24000",
		keyterm: "Parlume",
	});
	assert.equal(flux.accepted, true);
	assert.deepEqual(flux.sent, [4_800]);

	flux.turn({
		event: "EndOfTurn",
		turn_index: 0,
		audio_window_start: 0.5,
		audio_window_end: 2.3456,
		transcript: "Hey Fabric, what is the name of the project?",
	});
	await flush();
	await flush();

	assert.deepEqual(requests.find((r) => r.path.endsWith("/segments"))?.body, {
		sessionId: "session-1",
		botId: "bot-1",
		text: "Hey Fabric, what is the name of the project?",
		speakerName: "Dev One",
		speakerId: "1",
		utteranceStartMs: 500,
		utteranceEndMs: 2_346,
	});

	await sleep(700);
	const turn = requests.find((r) => r.path.endsWith("/turns"))?.body;
	assert.equal(turn?.text, "what is the name of the project?");
	assert.equal(turn?.speakerId, "1");
	assert.equal(turn?.botId, "bot-1");
});

test("a reply is played on the same socket the bot streams from", async () => {
	const { bridge, bot, frames } = meeting();
	await bridge.onStart();
	await bridge.onConnect(bot, {
		request: {
			url: "wss://bridge.example.com/parties/parlume/session-1?token=stream-token",
		},
	});
	await bridge.onMessage(
		bot,
		JSON.stringify({ bot_id: "bot-1", sample_rate: 24_000, start_time: 1 }),
	);

	const response = await bridge.onRequest(
		new Request(
			"https://bridge.example.com/parties/parlume/session-1?action=speak",
			{
				method: "POST",
				headers: {
					Authorization: "Bearer service-secret",
					"content-type": "audio/pcm",
					"x-parlume-voice-generation": "0",
				},
				body: new Uint8Array(3_840),
			},
		),
	);

	assert.equal(response.status, 200);
	const result = await response.json();
	assert.equal(result.played, true);
	assert.equal(result.interrupted, false);
	assert.deepEqual(frames, [1_920, 1_920]);
});
