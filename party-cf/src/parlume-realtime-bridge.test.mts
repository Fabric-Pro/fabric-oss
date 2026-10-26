import assert from "node:assert/strict";
import test from "node:test";
import { loadParlumeModule } from "./parlume-test-runtime.mts";

class FakeSocket {
	accepted = false;
	sent: Array<Record<string, unknown>> = [];
	private listeners = new Map<string, ((event: unknown) => void)[]>();
	accept() {
		this.accepted = true;
	}
	send(data: string | ArrayBuffer) {
		if (typeof data === "string") {
			this.sent.push(JSON.parse(data));
		}
	}
	close() {}
	addEventListener(type: string, listener: (event: unknown) => void) {
		this.listeners.set(type, [
			...(this.listeners.get(type) ?? []),
			listener,
		]);
	}
	emit(event: Record<string, unknown>) {
		for (const listener of this.listeners.get("message") ?? []) {
			listener({ data: JSON.stringify(event) });
		}
	}
	types() {
		return this.sent.map((event) => event.type);
	}
	drop() {
		for (const listener of this.listeners.get("close") ?? []) {
			listener({ code: 1006, reason: "gone" });
		}
	}
}

type Bridge = {
	onStart(): Promise<void>;
	onConnect(conn: unknown, ctx: { request: { url: string } }): Promise<void>;
	onMessage(conn: unknown, message: string): Promise<void>;
	onRequest(request: Request): Promise<Response>;
	onClose(conn: unknown): Promise<void>;
};

function meeting(options: { realtime: boolean; realtimeUrl?: string }) {
	const requests: Array<{
		url: string;
		headers: Record<string, string>;
		body: Record<string, unknown> | null;
	}> = [];
	const flux = new FakeSocket();
	const openai = new FakeSocket();
	const fetch = async (url: unknown, init: unknown) => {
		const { body, headers } = (init ?? {}) as {
			body?: string;
			headers?: Record<string, string>;
		};
		requests.push({
			url: String(url),
			headers: headers ?? {},
			body: typeof body === "string" ? JSON.parse(body) : null,
		});
		const path = new URL(String(url)).pathname;
		if (path.endsWith("/verify-stream")) {
			return Response.json({
				valid: true,
				hardStopAt: new Date(Date.now() + 3_600_000).toISOString(),
				streamGeneration: 1,
			});
		}
		if (path.endsWith("/realtime-session")) {
			return options.realtime
				? Response.json({
						clientSecret: "ek_meeting",
						expiresAt: 1_900_000_000,
						model: "gpt-realtime-2.1",
						...(options.realtimeUrl
							? { realtimeUrl: options.realtimeUrl }
							: {}),
					})
				: Response.json({ engine: "classic" }, { status: 404 });
		}
		if (path.endsWith("/v1/realtime")) {
			return { status: 101, webSocket: openai };
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
	const { Parlume } = loadParlumeModule("./parlume.ts", fetch) as {
		Parlume: new (ctx: unknown, env: unknown) => Bridge;
	};
	const bridge = new Parlume(
		{ storage },
		{
			FABRIC_API_URL: "https://fabric.example",
			AGENT_SERVICE_SECRET: "service-secret",
			AI: { run: async () => ({ status: 101, webSocket: flux }) },
		},
	);
	const sent: string[] = [];
	const bot = { send: (message: string) => sent.push(message), close() {} };
	const paths = () =>
		requests.map((request) => new URL(request.url).pathname);
	return { bridge, bot, flux, openai, requests, paths, sent };
}

const flush = async () => {
	for (let index = 0; index < 10; index++) {
		await new Promise((resolve) => setImmediate(resolve));
	}
};

const STREAM_URL =
	"wss://bridge.example.com/parties/parlume/session-1?token=stream-token";

function audio(timestampMs: number) {
	return JSON.stringify({
		trigger: "realtime_audio.mixed",
		bot_id: "bot_abc123",
		data: {
			chunk: Buffer.alloc(320).toString("base64"),
			timestamp_ms: timestampMs,
			sample_rate: 16_000,
		},
	});
}

function control(action: string, body: unknown) {
	return new Request(
		`https://bridge.example.com/parties/parlume/session-1?action=${action}`,
		{
			method: "POST",
			headers: {
				Authorization: "Bearer service-secret",
				"content-type": "application/json",
			},
			body: JSON.stringify(body),
		},
	);
}

async function joined(options: { realtime: boolean; realtimeUrl?: string }) {
	const live = meeting(options);
	await live.bridge.onStart();
	await live.bridge.onConnect(live.bot, { request: { url: STREAM_URL } });
	for (let end = 1_000_010; end <= 1_000_080; end += 10) {
		await live.bridge.onMessage(live.bot, audio(end));
	}
	await flush();
	return live;
}

test("an organization with an OpenAI key gets the realtime voice, fed the meeting's audio", async (t) => {
	const live = await joined({ realtime: true });
	t.after(() => live.bridge.onClose(live.bot));
	const session = live.requests.find((request) =>
		request.url.endsWith("/realtime-session"),
	);
	assert.deepEqual(session?.body, {
		sessionId: "session-1",
		botId: "bot_abc123",
	});
	const upgrade = live.requests.find((request) =>
		request.url.startsWith("https://api.openai.com/v1/realtime"),
	);
	assert.equal(upgrade?.headers.Authorization, "Bearer ek_meeting");
	assert.equal(live.openai.accepted, true);
	assert.deepEqual(live.openai.types(), ["session.update"]);
	for (let end = 1_000_090; end <= 1_000_200; end += 10) {
		await live.bridge.onMessage(live.bot, audio(end));
	}
	assert.ok(live.openai.types().includes("input_audio_buffer.append"));
	assert.equal(
		live.flux.sent.length > 0 || live.flux.accepted,
		true,
		"Flux still transcribes",
	);
});

test("a session minted on the organization's Azure resource opens that resource and bills it", async (t) => {
	const azure =
		"https://example-resource.openai.azure.com/openai/v1/realtime";
	const live = await joined({ realtime: true, realtimeUrl: azure });
	t.after(() => live.bridge.onClose(live.bot));
	const upgrade = live.requests.find((request) =>
		request.url.startsWith(azure),
	);
	assert.equal(upgrade?.url, `${azure}?model=gpt-realtime-2.1`);
	assert.equal(upgrade?.headers.Authorization, "Bearer ek_meeting");
	assert.equal(live.openai.accepted, true);

	live.openai.emit({
		type: "response.done",
		response: {
			id: "resp_1",
			status: "completed",
			output: [],
			usage: {
				input_token_details: { audio_tokens: 500, text_tokens: 100 },
				output_token_details: { audio_tokens: 60, text_tokens: 5 },
			},
		},
	});
	await flush();
	const usage = live.requests.find((request) =>
		request.url.endsWith("/realtime-usage"),
	);
	assert.equal(usage?.body?.provider, "AZURE_AI_FOUNDRY");
});

test("a wake phrase is answered by the realtime voice, not dispatched as a classic turn", async (t) => {
	const live = await joined({ realtime: true });
	t.after(() => live.bridge.onClose(live.bot));
	live.flux.emit({
		event: "Update",
		turn_index: 0,
		audio_window_start: 0.1,
		audio_window_end: 0.9,
		transcript: "Hey Fabric, what is",
	});
	await flush();
	assert.equal(live.openai.types().includes("response.create"), false);
	live.openai.emit({ type: "input_audio_buffer.speech_stopped" });
	assert.ok(live.openai.types().includes("response.create"));
	live.flux.emit({
		event: "EndOfTurn",
		turn_index: 0,
		audio_window_start: 0.1,
		audio_window_end: 1.5,
		transcript: "Hey Fabric, what is the status?",
	});
	await flush();
	await new Promise((resolve) => setTimeout(resolve, 50));
	assert.equal(live.paths().includes("/api/internal/parlume/turns"), false);
	assert.equal(
		live.openai.types().filter((type) => type === "response.create").length,
		1,
	);

	live.openai.emit({ type: "response.created", response: { id: "resp_1" } });
	live.openai.emit({
		type: "response.output_audio.delta",
		response_id: "resp_1",
		item_id: "item_1",
		delta: Buffer.alloc(9_600).toString("base64"),
	});
	assert.ok(
		live.sent.some((message) =>
			message.includes('"realtime_audio.bot_output"'),
		),
		"the voice reaches the bot",
	);

	// Someone talks over it: the response stops, cut to what was heard.
	live.flux.emit({
		event: "Update",
		turn_index: 1,
		audio_window_start: 2,
		audio_window_end: 2.6,
		transcript: "wait I have another question",
	});
	await flush();
	const tail = live.openai.types().slice(-2);
	assert.deepEqual(tail, ["response.cancel", "conversation.item.truncate"]);
});

test("a partial handled after its own final does not make the realtime voice answer again", async (t) => {
	const live = await joined({ realtime: true });
	t.after(() => live.bridge.onClose(live.bot));
	const responses = () =>
		live.openai.types().filter((type) => type === "response.create").length;
	live.flux.emit({
		event: "EndOfTurn",
		turn_index: 0,
		audio_window_start: 0.1,
		audio_window_end: 1.5,
		transcript: "Hey Fabric, what is the status?",
	});
	await flush();
	await new Promise((resolve) => setTimeout(resolve, 50));
	assert.equal(responses(), 1);
	live.openai.emit({ type: "response.created", response: { id: "resp_1" } });
	live.openai.emit({
		type: "response.done",
		response: { id: "resp_1", status: "completed", output: [] },
	});
	await flush();

	// A partial of the same utterance, handled late.
	live.flux.emit({
		event: "Update",
		turn_index: 0,
		audio_window_start: 0.1,
		audio_window_end: 1.2,
		transcript: "Hey Fabric, what is",
	});
	await flush();
	// Someone else talks, and stops.
	live.openai.emit({ type: "input_audio_buffer.speech_started" });
	live.openai.emit({ type: "input_audio_buffer.speech_stopped" });
	assert.equal(responses(), 1);
});

test("'Parlume, stop' is never answered by the realtime voice", async (t) => {
	const live = await joined({ realtime: true });
	t.after(() => live.bridge.onClose(live.bot));
	const answered = () => live.openai.types().includes("response.create");

	// The cancel is still being spoken when the voice hears the speech end.
	live.flux.emit({
		event: "Update",
		turn_index: 0,
		audio_window_start: 0.1,
		audio_window_end: 0.6,
		transcript: "Parlume,",
	});
	await flush();
	live.flux.emit({
		event: "Update",
		turn_index: 0,
		audio_window_start: 0.1,
		audio_window_end: 1,
		transcript: "Parlume, stop.",
	});
	await flush();
	live.openai.emit({ type: "input_audio_buffer.speech_stopped" });
	assert.equal(answered(), false);

	// Flux's final words arrive before the voice hears the speech end.
	live.flux.emit({
		event: "Update",
		turn_index: 1,
		audio_window_start: 2,
		audio_window_end: 2.5,
		transcript: "Parlume,",
	});
	await flush();
	live.flux.emit({
		event: "EndOfTurn",
		turn_index: 1,
		audio_window_start: 2,
		audio_window_end: 3,
		transcript: "Parlume, never mind.",
	});
	await flush();
	live.openai.emit({ type: "input_audio_buffer.speech_stopped" });
	assert.equal(answered(), false);
});

test("a request heard while the realtime voice reconnects is answered by the classic voice", async (t) => {
	const live = await joined({ realtime: true });
	t.after(() => live.bridge.onClose(live.bot));
	live.openai.drop();
	live.flux.emit({
		event: "EndOfTurn",
		turn_index: 0,
		audio_window_start: 0.1,
		audio_window_end: 1.5,
		transcript: "Hey Fabric, what is the status?",
	});
	for (
		let waited = 0;
		waited < 2_000 && !live.paths().includes("/api/internal/parlume/turns");
		waited += 20
	) {
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	const turn = live.requests.find((request) =>
		request.url.endsWith("/api/internal/parlume/turns"),
	);
	assert.equal(turn?.body?.text, "what is the status?");
	assert.equal(turn?.body?.delivery, undefined, "a classic turn");
});

test("a spoken chat post reference is acted on by the bridge, not left to the realtime model", async (t) => {
	const live = await joined({ realtime: true });
	t.after(() => live.bridge.onClose(live.bot));
	await live.bridge.onRequest(control("chat", { message: "Here is F-12." }));
	const texts = () =>
		live.openai.sent
			.filter((event) => event.type === "conversation.item.create")
			.map((event) => JSON.stringify(event));

	live.flux.emit({
		event: "Update",
		turn_index: 0,
		audio_window_start: 0.1,
		audio_window_end: 0.9,
		transcript: "Parlume read",
	});
	await flush();
	live.openai.emit({ type: "input_audio_buffer.speech_stopped" });
	assert.equal(
		live.openai.types().includes("response.create"),
		false,
		"a request that may name a post waits for its end",
	);
	live.flux.emit({
		event: "EndOfTurn",
		turn_index: 0,
		audio_window_start: 0.1,
		audio_window_end: 1.5,
		transcript: "Parlume read p one",
	});
	await flush();
	assert.equal(texts().length, 1);
	assert.match(texts()[0], /chat_post/);
	assert.match(texts()[0], /Here is F-12\./);
	assert.equal(
		live.openai.types().filter((type) => type === "response.create").length,
		1,
	);
	live.openai.emit({ type: "response.created", response: { id: "resp_1" } });
	live.openai.emit({
		type: "response.done",
		response: { id: "resp_1", status: "completed", output: [] },
	});

	live.flux.emit({
		event: "EndOfTurn",
		turn_index: 1,
		audio_window_start: 2,
		audio_window_end: 3.5,
		transcript: "Hey Parlume, tell me more about P1.",
	});
	await flush();
	assert.equal(texts().length, 2);
	assert.match(
		texts()[1],
		/meeting chat as P1 \(the label of that chat message, not a work item ID\): Here is F-12\./,
	);
	assert.equal(live.paths().includes("/api/internal/parlume/turns"), false);
});

test("ask_fabric runs as a Fabric turn and its result is spoken through the bridge", async (t) => {
	const live = await joined({ realtime: true });
	t.after(() => live.bridge.onClose(live.bot));
	live.flux.emit({
		event: "EndOfTurn",
		turn_index: 0,
		audio_window_start: 0.1,
		audio_window_end: 1.5,
		transcript: "Hey Fabric, file a bug for the export.",
	});
	await flush();
	live.openai.emit({ type: "response.created", response: { id: "resp_1" } });
	live.openai.emit({
		type: "response.done",
		response: {
			id: "resp_1",
			status: "completed",
			output: [
				{
					type: "function_call",
					call_id: "call_1",
					name: "ask_fabric",
					arguments: JSON.stringify({
						request: "File a bug for the export",
					}),
				},
			],
		},
	});
	await flush();
	const turn = live.requests.find((request) =>
		request.url.endsWith("/api/internal/parlume/turns"),
	);
	assert.equal(turn?.body?.delivery, "realtime");
	assert.equal(turn?.body?.job, "J1");
	assert.equal(turn?.body?.text, "File a bug for the export");
	const generation = turn?.body?.voiceGeneration;

	const state = await live.bridge.onRequest(
		control("verify-generation", { voiceGeneration: generation }),
	);
	assert.equal((await state.json()).current, true, "the job may act");

	live.openai.emit({ type: "response.created", response: { id: "resp_2" } });
	live.openai.emit({
		type: "response.done",
		response: { id: "resp_2", status: "completed", output: [] },
	});
	const delivered = await live.bridge.onRequest(
		control("fabric-result", {
			job: "J1",
			status: "completed",
			text: "Filed B-12, Export fails.",
			chatTags: [],
		}),
	);
	assert.deepEqual(await delivered.json(), { accepted: true });
	const spoken = live.openai.sent
		.filter((event) => event.type === "conversation.item.create")
		.map((event) => JSON.stringify(event.item));
	assert.ok(
		spoken.some((item) => item.includes("Filed B-12, Export fails.")),
	);
	assert.equal(live.openai.types().at(-1), "response.create");
});

test("without an OpenAI key the meeting runs on the classic engine", async (t) => {
	const live = await joined({ realtime: false });
	t.after(() => live.bridge.onClose(live.bot));
	assert.equal(
		live.requests.some((request) =>
			request.url.startsWith("https://api.openai.com"),
		),
		false,
	);
	live.flux.emit({
		event: "EndOfTurn",
		turn_index: 0,
		audio_window_start: 0.1,
		audio_window_end: 1.5,
		transcript: "Hey Fabric, what is the status?",
	});
	await flush();
	await new Promise((resolve) => setTimeout(resolve, 50));
	const turn = live.requests.find((request) =>
		request.url.endsWith("/api/internal/parlume/turns"),
	);
	assert.equal(turn?.body?.text, "what is the status?");
	assert.equal(turn?.body?.delivery, undefined);
	const result = await live.bridge.onRequest(
		control("fabric-result", { job: "J1", status: "completed", text: "x" }),
	);
	assert.deepEqual(await result.json(), { accepted: false });
});
