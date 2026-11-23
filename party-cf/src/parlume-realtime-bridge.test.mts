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

type MeetingOptions = {
	realtime: boolean;
	realtimeUrl?: string;
	/** A Fabric path that never answers; the request ends only when aborted. */
	hang?: string;
	/** Aura never answers until `answerAura` is called. */
	auraHangs?: boolean;
};

function meeting(options: MeetingOptions) {
	const requests: Array<{
		url: string;
		headers: Record<string, string>;
		body: Record<string, unknown> | null;
	}> = [];
	const flux = new FakeSocket();
	const openai = new FakeSocket();
	/** The text of each sentence Aura synthesized. */
	const aura: string[] = [];
	const heldClips: Array<(clip: Response) => void> = [];
	const answerAura = () => {
		for (const answer of heldClips.splice(0)) {
			answer(new Response(new Uint8Array(4_800)));
		}
	};
	const fetch = async (url: unknown, init: unknown) => {
		const { body, headers, signal } = (init ?? {}) as {
			body?: string;
			headers?: Record<string, string>;
			signal?: AbortSignal;
		};
		requests.push({
			url: String(url),
			headers: headers ?? {},
			body: typeof body === "string" ? JSON.parse(body) : null,
		});
		const path = new URL(String(url)).pathname;
		if (options.hang && path === options.hang) {
			return new Promise<Response>((_, reject) => {
				signal?.addEventListener("abort", () =>
					reject(new Error("aborted")),
				);
			});
		}
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
			AI: {
				run: async (model: string, inputs: { text?: string }) => {
					if (model === "@cf/deepgram/aura-2-en") {
						aura.push(inputs.text ?? "");
						if (options.auraHangs) {
							return new Promise<Response>((answer) =>
								heldClips.push(answer),
							);
						}
						return new Response(new Uint8Array(4_800));
					}
					return { status: 101, webSocket: flux };
				},
			},
		},
	);
	const sent: string[] = [];
	const bot = { send: (message: string) => sent.push(message), close() {} };
	const paths = () =>
		requests.map((request) => new URL(request.url).pathname);
	return {
		bridge,
		bot,
		flux,
		openai,
		requests,
		paths,
		sent,
		aura,
		answerAura,
	};
}

const flush = async () => {
	for (let index = 0; index < 10; index++) {
		await new Promise((resolve) => setImmediate(resolve));
	}
};

/**
 * Waits, two seconds at most, for `done`: a read aloud plays in real time
 * through the bot's outlet before the realtime voice may speak again.
 */
async function until(done: () => boolean) {
	for (let tries = 0; tries < 100 && !done(); tries++) {
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

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

async function joined(options: MeetingOptions) {
	const live = meeting(options);
	await live.bridge.onStart();
	await live.bridge.onConnect(live.bot, { request: { url: STREAM_URL } });
	for (let end = 1_000_010; end <= 1_000_080; end += 10) {
		await live.bridge.onMessage(live.bot, audio(end));
	}
	await flush();
	return live;
}

test("a session Fabric mints gets the realtime voice, which hears the meeting only from a wake phrase on", async (t) => {
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
	assert.equal(
		live.openai.types().includes("input_audio_buffer.append"),
		false,
		"nobody addressed Parlume: no meeting audio leaves the bridge",
	);
	assert.equal(
		live.flux.sent.length > 0 || live.flux.accepted,
		true,
		"Flux still transcribes",
	);
	live.flux.emit({
		event: "Update",
		turn_index: 0,
		audio_window_start: 0.1,
		audio_window_end: 0.9,
		transcript: "Hey Fabric, what is",
	});
	await flush();
	for (let end = 1_000_210; end <= 1_000_400; end += 10) {
		await live.bridge.onMessage(live.bot, audio(end));
	}
	assert.ok(
		live.openai.types().includes("input_audio_buffer.append"),
		"the request is heard, with the seconds before the wake phrase",
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
	// Answered once the speaker has stayed quiet briefly.
	await new Promise((resolve) => setTimeout(resolve, 650));
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

	// Someone talks over it: only a stop ends Parlume's answer, so the voice
	// goes on and nothing is cut.
	live.flux.emit({
		event: "Update",
		turn_index: 1,
		audio_window_start: 2,
		audio_window_end: 2.6,
		transcript: "wait I have another question",
	});
	await flush();
	live.flux.emit({
		event: "EndOfTurn",
		turn_index: 1,
		audio_window_start: 2,
		audio_window_end: 3,
		transcript: "wait I have another question for Dana",
	});
	await flush();
	live.openai.emit({
		type: "response.done",
		response: { id: "resp_1", status: "completed", output: [] },
	});
	await flush();
	assert.equal(live.openai.types().includes("response.cancel"), false);
	assert.equal(
		live.openai.types().includes("conversation.item.truncate"),
		false,
	);
	assert.equal(
		live.paths().includes("/api/internal/parlume/interrupt"),
		false,
	);
});

const botFrames = (live: Awaited<ReturnType<typeof joined>>) =>
	live.sent.filter((message) =>
		message.includes('"realtime_audio.bot_output"'),
	).length;

test("'Parlume, stop' holds the realtime voice on its partial and stops it on its final, cancelled, truncated and recorded as a voice stop", async (t) => {
	const live = await joined({ realtime: true });
	t.after(() => live.bridge.onClose(live.bot));
	live.flux.emit({
		event: "EndOfTurn",
		turn_index: 0,
		audio_window_start: 0.1,
		audio_window_end: 1.5,
		transcript: "Hey Fabric, what is the plan for next week?",
	});
	await flush();
	live.openai.emit({ type: "response.created", response: { id: "resp_1" } });
	// Two seconds of speech.
	live.openai.emit({
		type: "response.output_audio.delta",
		response_id: "resp_1",
		item_id: "item_1",
		delta: Buffer.alloc(96_000).toString("base64"),
	});
	await new Promise((resolve) => setTimeout(resolve, 250));

	live.flux.emit({
		event: "Update",
		turn_index: 1,
		audio_window_start: 2,
		audio_window_end: 2.4,
		transcript: "Parlume, stop",
	});
	await flush();
	const held = botFrames(live);
	await new Promise((resolve) => setTimeout(resolve, 300));
	assert.equal(botFrames(live), held, "the voice is held at once");
	assert.equal(live.openai.types().includes("response.cancel"), false);

	live.flux.emit({
		event: "EndOfTurn",
		turn_index: 1,
		audio_window_start: 2,
		audio_window_end: 2.6,
		transcript: "Parlume, stop.",
	});
	await until(() => live.paths().includes("/api/internal/parlume/interrupt"));

	assert.deepEqual(live.openai.types().slice(-2), [
		"response.cancel",
		"conversation.item.truncate",
	]);
	const interrupt = live.requests.find((request) =>
		request.url.endsWith("/api/internal/parlume/interrupt"),
	);
	assert.deepEqual(interrupt?.body?.stop, { cause: "VOICE", by: null });
	assert.equal(
		live.openai.types().filter((type) => type === "response.create").length,
		1,
		"the stop is never answered",
	);
});

// A partial handled after its own final once silenced the answer to that
// very request.
test("a partial handled after its own final does not silence the answer to it", async (t) => {
	const live = await joined({ realtime: true });
	t.after(() => live.bridge.onClose(live.bot));
	live.flux.emit({
		event: "EndOfTurn",
		turn_index: 0,
		audio_window_start: 0.1,
		audio_window_end: 1.5,
		transcript: "Hey Fabric, what is the status?",
	});
	await flush();
	await new Promise((resolve) => setTimeout(resolve, 50));
	live.openai.emit({ type: "response.created", response: { id: "resp_1" } });
	live.openai.emit({
		type: "response.output_audio.delta",
		response_id: "resp_1",
		item_id: "item_1",
		delta: Buffer.alloc(9_600).toString("base64"),
	});

	live.flux.emit({
		event: "Update",
		turn_index: 0,
		audio_window_start: 0.1,
		audio_window_end: 1.2,
		transcript: "Hey Fabric, what is",
	});
	await flush();
	live.openai.emit({
		type: "response.done",
		response: { id: "resp_1", status: "completed", output: [] },
	});
	await flush();

	assert.equal(
		live.openai.types().includes("conversation.item.truncate"),
		false,
	);
});

// A request to Fabric that never answered held the realtime voice's job, so
// every later ask_fabric found Fabric busy.
test("a request to Fabric that hangs settles after its timeout, and the job it held is cleared", async (t) => {
	const live = await joined({
		realtime: true,
		hang: "/api/internal/parlume/turns",
	});
	t.after(() => live.bridge.onClose(live.bot));
	live.flux.emit({
		event: "EndOfTurn",
		turn_index: 0,
		audio_window_start: 0.1,
		audio_window_end: 1.5,
		transcript: "Hey Fabric, file a bug for the export.",
	});
	await flush();
	t.mock.timers.enable({ apis: ["setTimeout"] });
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
	live.openai.emit({ type: "response.created", response: { id: "resp_2" } });
	live.openai.emit({
		type: "response.done",
		response: { id: "resp_2", status: "completed", output: [] },
	});
	await flush();
	assert.ok(live.paths().includes("/api/internal/parlume/turns"));
	const notFinished = () =>
		live.openai.sent.some((event) =>
			JSON.stringify(event).includes("Fabric could not finish J1"),
		);
	assert.equal(notFinished(), false);

	t.mock.timers.tick(15_000);
	await flush();

	assert.equal(notFinished(), true);
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

// "Hey, Fabric." on its own was answered ("I'm here."). Once that short reply
// had played the voice stopped listening, which dropped the request said
// meanwhile, and the request's end was answered "I didn't catch a question
// yet.": no Fabric job ran.
test("a wake phrase on its own is not answered; the voice listens on and answers the request that follows", async (t) => {
	const live = await joined({ realtime: true });
	t.after(() => live.bridge.onClose(live.bot));
	const responses = () =>
		live.openai.types().filter((type) => type === "response.create").length;

	live.flux.emit({
		event: "Update",
		turn_index: 0,
		audio_window_start: 0.1,
		audio_window_end: 0.6,
		transcript: "Hey, Fabric",
	});
	await flush();
	live.openai.emit({ type: "input_audio_buffer.speech_started" });
	live.openai.emit({ type: "input_audio_buffer.speech_stopped" });
	live.flux.emit({
		event: "EndOfTurn",
		turn_index: 0,
		audio_window_start: 0.1,
		audio_window_end: 0.9,
		transcript: "Hey, Fabric.",
	});
	await flush();
	assert.equal(responses(), 0, "a wake phrase alone is not answered");

	// The request, said two seconds later, reaches the voice whole.
	live.openai.emit({ type: "input_audio_buffer.speech_started" });
	for (let end = 1_000_090; end <= 1_000_300; end += 10) {
		await live.bridge.onMessage(live.bot, audio(end));
	}
	live.flux.emit({
		event: "EndOfTurn",
		turn_index: 1,
		audio_window_start: 2.9,
		audio_window_end: 4.9,
		transcript: "What is this project about?",
	});
	await flush();

	assert.equal(
		live.openai.types().includes("input_audio_buffer.clear"),
		false,
		"the request's audio is never dropped",
	);
	assert.equal(responses(), 1, "the request is answered once");
	assert.ok(
		live.openai.sent.some((event) =>
			JSON.stringify(event).includes("just addressed you"),
		),
	);
	assert.equal(live.paths().includes("/api/internal/parlume/turns"), false);
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
	assert.deepEqual(live.aura, ["Here is F-12."], "read word for word");
	assert.equal(
		live.openai.types().includes("response.create"),
		false,
		"the model is not asked to read it",
	);
	await until(() => texts().length === 1);
	assert.match(texts()[0], /read_aloud/);
	assert.match(texts()[0], /Here is F-12\./);

	live.flux.emit({
		event: "EndOfTurn",
		turn_index: 1,
		audio_window_start: 2,
		audio_window_end: 3.5,
		transcript: "Hey Parlume, tell me more about P1.",
	});
	await flush();
	await until(() => texts().length === 2);
	assert.equal(texts().length, 2);
	assert.match(
		texts()[1],
		/meeting chat as P1 \(the label of that chat message, not a work item ID\): Here is F-12\./,
	);
	assert.equal(live.paths().includes("/api/internal/parlume/turns"), false);
});

// "go P9" for a post the meeting does not have once armed the realtime voice,
// which answered the tag as a request of its own.
test("a spoken reference to a post the meeting does not have reads the fixed line in the realtime voice", async (t) => {
	const live = await joined({ realtime: true });
	t.after(() => live.bridge.onClose(live.bot));

	live.flux.emit({
		event: "EndOfTurn",
		turn_index: 0,
		audio_window_start: 0.1,
		audio_window_end: 1.5,
		transcript: "Hey Fabric, go P9",
	});
	await flush();
	await new Promise((resolve) => setTimeout(resolve, 50));
	live.openai.emit({ type: "input_audio_buffer.speech_stopped" });

	assert.match(
		live.aura.join(" "),
		/^P9: There is no P9 in this meeting's chat\. Check the tag on the post you mean\.$/,
	);
	const texts = () =>
		live.openai.sent
			.filter((event) => event.type === "conversation.item.create")
			.map((event) => JSON.stringify(event));
	await until(() => texts().length === 1);
	assert.equal(texts().length, 1);
	assert.match(texts()[0], /read_aloud/);
	assert.doesNotMatch(texts()[0], /just addressed you/);
	assert.equal(live.openai.types().includes("response.create"), false);
	assert.equal(live.paths().includes("/api/internal/parlume/turns"), false);
});

function chatMessage(
	id: string,
	text: string,
	sender = { name: "Dev One", id: "participant-1" },
) {
	return control("chat-message", {
		id,
		text,
		senderName: sender.name,
		senderId: sender.id,
		toBot: false,
		timestampMs: 1_700_000_000_000,
	});
}

// The realtime voice once queued the post behind the answer in progress; then
// "go" cancelled the meeting turn too, stopping Fabric work mid-write. Later
// the latest "go" cut the read before it: now each read waits its turn, and
// opens with the name of whoever typed it.
test("'go' leaves the realtime voice's answer running, and two 'go's are read in the order they were typed", async (t) => {
	const live = await joined({ realtime: true });
	t.after(() => live.bridge.onClose(live.bot));
	await live.bridge.onRequest(control("chat", { message: "Here is F-12." }));
	await live.bridge.onRequest(control("chat", { message: "Here is F-13." }));
	live.flux.emit({
		event: "EndOfTurn",
		turn_index: 0,
		audio_window_start: 0.1,
		audio_window_end: 1.5,
		transcript: "Hey Fabric, what is the plan for next week?",
	});
	await flush();
	live.openai.emit({ type: "response.created", response: { id: "resp_1" } });

	const ana = { name: "Ana Example", id: "participant-2" };
	// Nothing is flushed between the two.
	await live.bridge.onRequest(chatMessage("msg_1", "go P1"));
	await live.bridge.onRequest(chatMessage("msg_2", "go P2", ana));
	await flush();
	assert.equal(
		live.openai.types().includes("response.cancel"),
		false,
		"the answer runs on, so a request it makes is not lost",
	);
	const reads = () =>
		live.openai.sent
			.filter((event) => event.type === "conversation.item.create")
			.map((event) => JSON.stringify(event))
			.filter((item) => item.includes("read_aloud"));

	live.openai.emit({
		type: "response.done",
		response: { id: "resp_1", status: "completed", output: [] },
	});
	await flush();
	await until(() => reads().length === 2);
	assert.deepEqual(live.aura, ["Dev, Here is F-12.", "Ana, Here is F-13."]);
	assert.equal(reads().length, 2, "each read is played whole");
	assert.match(reads()[0], /Here is F-12\./);
	assert.match(reads()[1], /Here is F-13\./);
	assert.equal(
		live.openai.types().filter((type) => type === "response.create").length,
		1,
		"the model is asked for no read",
	);
	assert.equal(
		live.paths().includes("/api/internal/parlume/interrupt"),
		false,
		"no meeting turn is cancelled",
	);
});

test("a typed stop after response.done, while the realtime answer still plays, cancels and truncates it and ends the turn", async (t) => {
	const live = await joined({ realtime: true });
	t.after(() => live.bridge.onClose(live.bot));
	live.flux.emit({
		event: "EndOfTurn",
		turn_index: 0,
		audio_window_start: 0.1,
		audio_window_end: 1.5,
		transcript: "Hey Fabric, what is the plan for next week?",
	});
	await flush();
	live.openai.emit({ type: "response.created", response: { id: "resp_1" } });
	live.openai.emit({
		type: "response.output_audio.delta",
		response_id: "resp_1",
		item_id: "item_1",
		delta: Buffer.alloc(48_000).toString("base64"),
	});
	live.openai.emit({
		type: "response.done",
		response: { id: "resp_1", status: "completed", output: [] },
	});
	await flush();

	await live.bridge.onRequest(chatMessage("msg_1", "stop"));
	await flush();

	assert.deepEqual(live.openai.types().slice(-2), [
		"response.cancel",
		"conversation.item.truncate",
	]);
	const interrupt = live.requests.find((request) =>
		request.url.endsWith("/api/internal/parlume/interrupt"),
	);
	assert.deepEqual(interrupt?.body?.stop, { cause: "CHAT", by: "Dev One" });
	const stopped = live.requests
		.filter((request) => request.url.endsWith("/api/internal/parlume/chat"))
		.map((request) => request.body?.message);
	assert.deepEqual(stopped, ["[P1] **Stopped** · Dev stopped the answer"]);
});

test("'go' leaves a running Fabric job and its queued answer alone in the realtime voice", async (t) => {
	const live = await joined({ realtime: true });
	t.after(() => live.bridge.onClose(live.bot));
	await live.bridge.onRequest(control("chat", { message: "Here is F-12." }));
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
	const generation = live.requests.find((request) =>
		request.url.endsWith("/api/internal/parlume/turns"),
	)?.body?.voiceGeneration;
	live.openai.emit({ type: "response.created", response: { id: "resp_2" } });

	await live.bridge.onRequest(chatMessage("msg_1", "go P1"));
	await flush();

	const state = await live.bridge.onRequest(
		control("verify-generation", { voiceGeneration: generation }),
	);
	assert.equal((await state.json()).current, true, "the job runs on");
	live.openai.emit({
		type: "response.done",
		response: { id: "resp_2", status: "cancelled", output: [] },
	});
	await flush();
	const delivered = await live.bridge.onRequest(
		control("fabric-result", {
			job: "J1",
			status: "completed",
			text: "Filed B-12, Export fails.",
			chatTags: [],
			turnId: "turn-1",
		}),
	);
	assert.deepEqual(await delivered.json(), { accepted: true });

	// A second "go" while the answer waits behind the read keeps it queued.
	await live.bridge.onRequest(chatMessage("msg_2", "go P1"));
	await flush();
	const items = () =>
		live.openai.sent
			.filter((event) => event.type === "conversation.item.create")
			.map((event) => JSON.stringify(event.item));
	assert.equal(
		items().some((item) => item.includes("Filed B-12, Export fails.")),
		false,
		"the answer waits for the read",
	);
	await until(
		() => items().at(-1)?.includes("Filed B-12, Export fails.") === true,
	);
	assert.ok(items().at(-1)?.includes("Filed B-12, Export fails."));
	assert.equal(live.openai.types().at(-1), "response.create");
	assert.equal(
		live.paths().includes("/api/internal/parlume/interrupt"),
		false,
	);
});

// The realtime voice once waited for the read's synthesis to give up, so an
// Aura call that hung kept it silent after the read was stopped.
test("a stop over a read whose synthesis hangs lets the realtime voice answer at once", async (t) => {
	const live = await joined({ realtime: true, auraHangs: true });
	t.after(() => {
		live.answerAura();
		return live.bridge.onClose(live.bot);
	});
	await live.bridge.onRequest(control("chat", { message: "Here is F-12." }));
	await live.bridge.onRequest(chatMessage("msg_1", "go P1"));
	await until(() => live.aura.length === 1);
	assert.deepEqual(live.aura, ["Here is F-12."], "the read has begun");

	// Talk over the read does not end it.
	live.flux.emit({
		event: "EndOfTurn",
		turn_index: 0,
		audio_window_start: 0.1,
		audio_window_end: 1,
		transcript: "Sorry, one more thing about the export.",
	});
	await flush();
	assert.equal(
		live.paths().includes("/api/internal/parlume/interrupt"),
		false,
	);

	await live.bridge.onRequest(chatMessage("msg_2", "stop"));
	await flush();
	live.flux.emit({
		event: "EndOfTurn",
		turn_index: 1,
		audio_window_start: 1.2,
		audio_window_end: 2,
		transcript: "Hey Fabric, what is the plan?",
	});
	await flush();

	assert.equal(
		live.openai.types().filter((type) => type === "response.create").length,
		1,
		"the voice answers without waiting for Aura",
	);
});

// "go" once cancelled the classic turn being answered: its workflow stopped
// and the actions it was taking were marked unknown. Later it muted the
// answer, which then went to the chat: now the read waits for it instead,
// and follows once the answer has been spoken.
/** `read` is the post as read, opening with the name of who asked, if known. */
async function goKeepsClassicTurn(
	live: Awaited<ReturnType<typeof joined>>,
	go: () => Promise<unknown>,
	read: string,
) {
	await live.bridge.onRequest(control("chat", { message: "Here is F-12." }));
	live.flux.emit({
		event: "EndOfTurn",
		turn_index: 0,
		audio_window_start: 0.1,
		audio_window_end: 1.5,
		transcript: "Hey Fabric, what is the status?",
	});
	await flush();
	await new Promise((resolve) => setTimeout(resolve, 50));
	const generation = live.requests.find((request) =>
		request.url.endsWith("/api/internal/parlume/turns"),
	)?.body?.voiceGeneration;
	assert.equal(typeof generation, "number");

	await go();
	await new Promise((resolve) => setTimeout(resolve, 100));

	assert.deepEqual(live.aura, [], "the read waits for the answer");
	assert.equal(
		live.paths().includes("/api/internal/parlume/interrupt"),
		false,
		"Fabric is told nothing: the turn runs on",
	);
	const state = await (
		await live.bridge.onRequest(
			control("verify-generation", { voiceGeneration: generation }),
		)
	).json();
	assert.equal(state.current, true);
	assert.equal("muted" in state, false);

	// The answer plays in real time on the outlet, whose timers do not keep
	// the test process alive.
	const keepAlive = setInterval(() => {}, 1_000);
	const answer = await live.bridge
		.onRequest(
			new Request(
				"https://bridge.example.com/parties/parlume/session-1?action=say",
				{
					method: "POST",
					headers: {
						Authorization: "Bearer service-secret",
						"content-type": "application/x-ndjson",
						"x-parlume-voice-generation": String(generation),
					},
					body: `${JSON.stringify({ text: "All is on track." })}\n`,
				},
			),
		)
		.finally(() => clearInterval(keepAlive));
	assert.equal((await answer.json()).played, true);
	await until(() => live.aura.length === 2);
	assert.deepEqual(live.aura, ["All is on track.", read]);
}

test("'go' typed in the classic voice reads the post without cancelling or muting the turn being answered", async (t) => {
	const live = await joined({ realtime: false });
	t.after(() => live.bridge.onClose(live.bot));
	await goKeepsClassicTurn(
		live,
		() => live.bridge.onRequest(chatMessage("msg_1", "go P1")),
		"Dev, Here is F-12.",
	);
});

test("'Hey Fabric, go P1' said in the classic voice does not cancel the turn being answered on its wake phrase", async (t) => {
	const live = await joined({ realtime: false });
	t.after(() => live.bridge.onClose(live.bot));
	await goKeepsClassicTurn(
		live,
		async () =>
			live.flux.emit({
				event: "EndOfTurn",
				turn_index: 1,
				audio_window_start: 2,
				audio_window_end: 3.5,
				transcript: "Hey Fabric, go P1",
			}),
		// The meeting never named the speaker.
		"Here is F-12.",
	);
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
			turnId: "turn-1",
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

	live.openai.emit({ type: "response.created", response: { id: "resp_3" } });
	live.openai.emit({
		type: "response.done",
		response: { id: "resp_3", status: "completed", output: [] },
	});
	await flush();
	const timing = live.requests.find((request) =>
		request.url.endsWith("/api/internal/parlume/realtime-spoken"),
	);
	assert.deepEqual(timing?.body, {
		sessionId: "session-1",
		botId: "bot_abc123",
		turnId: "turn-1",
		firstAudioAt: null,
		spokenAt: null,
		interrupted: false,
	});
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

// "go P8" said while a request was being handed to Fabric was answered as a
// request ("I'm still on the earlier request") and the post was never read.
test("a spoken 'go' while a request is handed to Fabric reads the post, and Fabric's answer still arrives", async (t) => {
	const live = await joined({ realtime: true });
	t.after(() => live.bridge.onClose(live.bot));
	await live.bridge.onRequest(control("chat", { message: "Here is F-12." }));
	live.flux.emit({
		event: "EndOfTurn",
		turn_index: 0,
		audio_window_start: 0.1,
		audio_window_end: 1.5,
		transcript: "Hey Fabric, file a bug for the export.",
	});
	await flush();
	live.openai.emit({ type: "response.created", response: { id: "resp_1" } });
	live.flux.emit({
		event: "EndOfTurn",
		turn_index: 1,
		audio_window_start: 2,
		audio_window_end: 3.5,
		transcript: "Hey Fabric, go P1",
	});
	await flush();
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
	assert.equal(turn?.body?.job, "J1", "the request reaches Fabric");
	const creates = () =>
		live.openai.types().filter((type) => type === "response.create").length;
	// The read waits for the answer in progress, which ends with the answer
	// to its tool call.
	await until(() => creates() === 2);
	assert.equal(creates(), 2);
	assert.deepEqual(live.aura, [], "the read waits for the answer");
	live.openai.emit({ type: "response.created", response: { id: "resp_2" } });
	live.openai.emit({
		type: "response.done",
		response: { id: "resp_2", status: "completed", output: [] },
	});
	await flush();
	const reads = () =>
		live.openai.sent
			.filter((event) => event.type === "conversation.item.create")
			.map((event) => JSON.stringify(event))
			.filter((item) => item.includes("read_aloud"));
	await until(() => reads().length === 1);
	assert.deepEqual(live.aura, ["Here is F-12."], "read as written");
	assert.equal(reads().length, 1, "the read is played whole");
	const delivered = await live.bridge.onRequest(
		control("fabric-result", {
			job: "J1",
			status: "completed",
			text: "Filed B-12, Export fails.",
			chatTags: [],
			turnId: "turn-1",
		}),
	);
	assert.deepEqual(await delivered.json(), { accepted: true });
	const items = live.openai.sent
		.filter((event) => event.type === "conversation.item.create")
		.map((event) => JSON.stringify(event.item));
	assert.ok(items.at(-1)?.includes("Filed B-12, Export fails."));
	assert.equal(live.openai.types().at(-1), "response.create");
});
