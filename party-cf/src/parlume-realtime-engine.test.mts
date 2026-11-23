import assert from "node:assert/strict";
import { type TestContext, test } from "node:test";
import { loadParlumeModule } from "./parlume-test-runtime.mts";

type Engine = {
	active: boolean;
	start(): Promise<{ ok: boolean; reason?: string }>;
	stop(reason: string): void;
	arm(input: {
		requester: string | null;
		speakerKey: string;
		request?: string;
		endOfTurn: boolean;
	}): void;
	closeForCap(): void;
	awaitRequest(input: {
		requester: string | null;
		speakerKey: string;
		forMs: number;
	}): void;
	noteLine(speaker: string | null, text: string): void;
	restore(context: unknown): void;
	holdForRead(text: string, droppedBytes: number): (said: boolean) => void;
	respondToChat(
		speaker: string | null,
		text: string,
		speakerKey?: string | null,
	): Promise<boolean>;
	respondToRequest(
		speaker: string | null,
		speakerKey: string,
		text: string,
	): Promise<boolean>;
	requesterKey(): string | null;
	holdsFloor(): boolean;
	deliverResult(input: {
		job: string;
		status: "completed" | "failed";
		text: string;
		chatTags: string[];
		turnId?: string;
	}): boolean;
	isPlaying(): boolean;
	isResponding(): boolean;
	hasJob(generation: number): boolean;
	silence(droppedBytes: number): void;
	appendAudio(pcm: Uint8Array, sampleRate: number): void;
};

function loadEngine() {
	return loadParlumeModule("./parlume-realtime-engine.ts", async () =>
		Response.json({}),
	) as {
		ParlumeRealtimeEngine: new (host: unknown) => Engine;
	};
}

const flush = () => new Promise((resolve) => setImmediate(resolve));
/** Past the quiet the voice waits for after OpenAI ends a turn. */
const afterPause = () => new Promise((resolve) => setTimeout(resolve, 650));
const plain = (value: unknown) => JSON.parse(JSON.stringify(value));

class FakeSocket {
	sent: Array<Record<string, unknown>> = [];
	closed = false;
	private listeners = new Map<string, Array<(event: unknown) => void>>();
	send(data: string) {
		this.sent.push(JSON.parse(data));
	}
	close() {
		this.closed = true;
	}
	addEventListener(type: string, listener: (event: unknown) => void) {
		this.listeners.set(type, [
			...(this.listeners.get(type) ?? []),
			listener,
		]);
	}
	server(event: Record<string, unknown>) {
		for (const listener of this.listeners.get("message") ?? []) {
			listener({ data: JSON.stringify(event) });
		}
	}
	drop() {
		for (const listener of this.listeners.get("close") ?? []) {
			listener({ code: 1006, reason: "gone" });
		}
	}
	types() {
		return this.sent.map((event) => event.type);
	}
	clear() {
		this.sent = [];
	}
}

function harness(
	options: {
		credentials?: () => unknown;
		connect?: () => Promise<FakeSocket>;
		accept?: boolean;
		/** Resolves when the outlet has played everything queued; never by default. */
		drained?: () => Promise<void>;
		chat?: Array<{ from: string | null; text: string }>;
		/** Whether the meeting chat shows a voice post in time; not by default. */
		shown?: boolean;
		/** The voice floor's gate; open by default. */
		maySpeak?: () => boolean;
		/** The meeting's last two minutes before its cap; not by default. */
		closing?: () => boolean;
	} = {},
) {
	const sockets: FakeSocket[] = [];
	const enqueued: number[] = [];
	const jobs: Array<Record<string, unknown>> = [];
	const usage: unknown[] = [];
	const spoken: Array<Record<string, unknown>> = [];
	const posted: string[] = [];
	const fallbacks: string[] = [];
	const contexts: unknown[] = [];
	const logs: Array<{ event: string; meta: Record<string, unknown> }> = [];
	const outlet = {
		droppedBytes: 0,
		ended: 0,
		enqueue(bytes: Uint8Array) {
			enqueued.push(bytes.byteLength);
		},
		end() {
			this.ended++;
		},
		clear() {},
		drained: options.drained ?? (() => new Promise<void>(() => {})),
	};
	let outletGone = false;
	let clock = 1_000;
	const { ParlumeRealtimeEngine } = loadEngine();
	const engine = new ParlumeRealtimeEngine({
		credentials: async () =>
			options.credentials
				? options.credentials()
				: { clientSecret: "ek_test", model: "gpt-realtime-2.1" },
		connect:
			options.connect ??
			(async () => {
				const socket = new FakeSocket();
				sockets.push(socket);
				return socket;
			}),
		outlet: () => (outletGone ? null : outlet),
		generation: () => 7,
		maySpeak: options.maySpeak ?? (() => true),
		closing: options.closing ?? (() => false),
		dispatchJob: async (job: Record<string, unknown>) => {
			jobs.push(job);
			return options.accept ?? true;
		},
		postChat: async (text: string) => {
			posted.push(text);
			return { posted: true, tag: "P3", shown: options.shown ?? false };
		},
		readChat: () => options.chat ?? [{ from: "Sam", text: "Link?" }],
		reportUsage: (entry: unknown) => usage.push(entry),
		reportSpoken: (entry: Record<string, unknown>) =>
			spoken.push(plain(entry)),
		saveContext: (context: unknown) => contexts.push(plain(context)),
		fallBack: (reason: string) => fallbacks.push(reason),
		log: (_level: string, event: string, meta: Record<string, unknown>) =>
			logs.push({ event, meta: plain(meta) }),
		now: () => clock,
	});
	return {
		engine,
		sockets,
		socket: () => sockets[sockets.length - 1],
		enqueued,
		jobs,
		usage,
		spoken,
		posted,
		fallbacks,
		contexts,
		logs,
		outlet,
		/** The bot's stream is gone: the host has no outlet to play on. */
		dropOutlet() {
			outletGone = true;
		},
		advance(ms: number) {
			clock += ms;
		},
	};
}

function audioDelta(responseId: string, bytes: number) {
	return {
		type: "response.output_audio.delta",
		response_id: responseId,
		item_id: `item_${responseId}`,
		delta: Buffer.alloc(bytes).toString("base64"),
	};
}

function done(
	responseId: string,
	output: unknown[] = [],
	status = "completed",
	statusDetails: Record<string, unknown> | null = null,
) {
	return {
		type: "response.done",
		response: {
			id: responseId,
			status,
			status_details: statusDetails,
			output,
			usage: {
				input_token_details: {
					audio_tokens: 500,
					text_tokens: 100,
					cached_tokens_details: {
						audio_tokens: 400,
						text_tokens: 50,
					},
				},
				output_token_details: { audio_tokens: 60, text_tokens: 5 },
			},
		},
	};
}

function transcriptDelta(responseId: string, delta: string) {
	return {
		type: "response.output_audio_transcript.delta",
		response_id: responseId,
		item_id: `item_${responseId}`,
		delta,
	};
}

/** Time passes on the engine's clock and its timers alike. */
async function pass(t: TestContext, h: ReturnType<typeof harness>, ms: number) {
	h.advance(ms);
	t.mock.timers.tick(ms);
	await flush();
	await flush();
}

type ResponseCreate = { response?: { metadata?: { kind?: string } } };

/** The kind of the last response `socket` was asked for. */
function lastResponseKind(socket: FakeSocket): string | undefined {
	const index = socket.types().lastIndexOf("response.create");
	const created = socket.sent[index] as ResponseCreate | undefined;
	return created?.response?.metadata?.kind;
}

function systemTexts(socket: FakeSocket): string[] {
	return socket.sent
		.filter((event) => event.type === "conversation.item.create")
		.map(
			(event) =>
				event.item as { role?: string; content?: { text: string }[] },
		)
		.filter((item) => item.role === "system")
		.map((item) => item.content?.[0]?.text ?? "");
}

test("without a client secret the meeting stays classic", async () => {
	const { engine } = harness({ credentials: () => null });
	assert.deepEqual(plain(await engine.start()), {
		ok: false,
		reason: "no_credentials",
	});
	assert.equal(engine.active, false);
});

test("a socket that cannot open leaves the meeting classic", async () => {
	const { engine } = harness({
		connect: async () => {
			throw new Error("HTTP 401");
		},
	});
	assert.deepEqual(plain(await engine.start()), {
		ok: false,
		reason: "connect_failed",
	});
});

test("the realtime session hears the meeting only from a wake phrase to the end of the reply", async () => {
	const { engine, socket } = harness({ drained: () => Promise.resolve() });
	await engine.start();
	socket().clear();
	const chunk = () => engine.appendAudio(new Uint8Array(320), 16_000);
	for (let index = 0; index < 20; index++) {
		chunk();
	}
	assert.deepEqual(socket().types(), [], "nobody addressed Parlume");
	engine.arm({ requester: "Dev One", speakerKey: "p1", endOfTurn: false });
	assert.ok(
		socket().types().includes("input_audio_buffer.append"),
		"the seconds before the wake phrase are sent once it is heard",
	);
	socket().server({ type: "input_audio_buffer.speech_stopped" });
	await afterPause();
	assert.ok(socket().types().includes("response.create"));
	socket().server(done("resp_1"));
	await flush();
	socket().clear();
	chunk();
	assert.deepEqual(
		socket().types(),
		["input_audio_buffer.clear"],
		"the reply is over: the session's unfinished input is dropped",
	);
	chunk();
	assert.deepEqual(socket().types(), ["input_audio_buffer.clear"]);
});

test("the realtime voice neither arms nor answers while Parlume may not speak", async () => {
	let open = true;
	const { engine, socket } = harness({ maySpeak: () => open });
	await engine.start();
	socket().clear();
	open = false;
	engine.arm({ requester: "Dev One", speakerKey: "p1", endOfTurn: true });
	const answered = await engine.respondToChat("Dev One", "What is next?");
	assert.equal(answered, false);
	assert.equal(socket().types().includes("response.create"), false);
});

test("speech alone never makes Parlume answer", async () => {
	const { engine, socket } = harness();
	await engine.start();
	assert.deepEqual(socket().types(), ["session.update"]);
	socket().server({ type: "input_audio_buffer.speech_started" });
	socket().server({ type: "input_audio_buffer.speech_stopped" });
	assert.equal(socket().types().includes("response.create"), false);
});

test("a wake phrase mid-utterance is answered when the speaker stops, once", async () => {
	const { engine, socket } = harness();
	await engine.start();
	socket().clear();
	socket().server({ type: "input_audio_buffer.speech_started" });
	engine.arm({ requester: "Dev One", speakerKey: "p1", endOfTurn: false });
	assert.equal(socket().types().includes("response.create"), false);
	socket().server({ type: "input_audio_buffer.speech_stopped" });
	await afterPause();
	assert.deepEqual(socket().types(), [
		"conversation.item.create",
		"response.create",
	]);
	assert.match(systemTexts(socket())[0], /^Dev One just addressed you/);
	// Flux's final for the same utterance arrives afterwards.
	engine.arm({ requester: "Dev One", speakerKey: "p1", endOfTurn: true });
	assert.equal(
		socket()
			.types()
			.filter((type) => type === "response.create").length,
		1,
	);
});

test("a pause after the wake phrase is not answered when the speaker goes on: the request is answered once", async () => {
	const { engine, socket } = harness();
	await engine.start();
	socket().clear();
	const responses = () =>
		socket()
			.types()
			.filter((type) => type === "response.create").length;
	socket().server({ type: "input_audio_buffer.speech_started" });
	engine.arm({ requester: "Dev One", speakerKey: "p1", endOfTurn: false });
	// "Hey Fabric, …": OpenAI ends the turn at the pause, and the speaker goes on.
	socket().server({ type: "input_audio_buffer.speech_stopped" });
	socket().server({ type: "input_audio_buffer.speech_started" });
	await afterPause();
	assert.equal(responses(), 0, "the pause after the name is not answered");
	engine.arm({ requester: "Dev One", speakerKey: "p1", endOfTurn: false });
	// Flux's end of turn answers at once.
	engine.arm({ requester: "Dev One", speakerKey: "p1", endOfTurn: true });
	assert.equal(responses(), 1);
	socket().server({ type: "input_audio_buffer.speech_stopped" });
	await afterPause();
	assert.equal(responses(), 1, "the request is answered once");
});

test("a wake phrase not refreshed for five seconds is not answered when someone else stops talking", async () => {
	const { engine, socket, advance, logs } = harness();
	await engine.start();
	socket().clear();
	engine.arm({ requester: "Dev One", speakerKey: "p1", endOfTurn: false });
	advance(5_001);
	socket().server({ type: "input_audio_buffer.speech_started" });
	socket().server({ type: "input_audio_buffer.speech_stopped" });
	await afterPause();
	assert.equal(socket().types().includes("response.create"), false);
	assert.ok(logs.some((entry) => entry.event === "realtime.arm_expired"));
});

test("a wake phrase on its own is not answered: the voice listens until the request is handed over, then answers it once", async () => {
	const { engine, socket, logs } = harness();
	await engine.start();
	socket().clear();
	const chunk = () => engine.appendAudio(new Uint8Array(320), 16_000);
	const responses = () =>
		socket()
			.types()
			.filter((type) => type === "response.create").length;

	engine.awaitRequest({
		requester: "Dev One",
		speakerKey: "p1",
		forMs: 15_000,
	});
	socket().server({ type: "input_audio_buffer.speech_started" });
	socket().server({ type: "input_audio_buffer.speech_stopped" });
	for (let index = 0; index < 20; index++) {
		chunk();
	}
	assert.equal(responses(), 0, "the wake phrase alone gets no reply");
	assert.equal(
		socket().types().includes("input_audio_buffer.clear"),
		false,
		"the request said next is heard whole",
	);

	socket().server({ type: "input_audio_buffer.speech_started" });
	engine.arm({ requester: "Dev One", speakerKey: "p1", endOfTurn: true });
	socket().server({ type: "input_audio_buffer.speech_stopped" });

	assert.equal(responses(), 1);
	assert.match(
		systemTexts(socket()).at(-1) ?? "",
		/^Dev One just addressed you/,
	);
	assert.deepEqual(
		logs
			.filter((entry) => entry.event === "realtime.armed")
			.map((entry) => entry.meta),
		[{ endOfTurn: false, requesterKnown: true, awaitingRequest: true }],
	);
});

test("a wake phrase on its own whose request never comes stops listening after its window", async () => {
	const { engine, socket, advance, logs } = harness();
	await engine.start();
	socket().clear();
	const chunk = () => engine.appendAudio(new Uint8Array(320), 16_000);
	engine.awaitRequest({ requester: null, speakerKey: "p1", forMs: 15_000 });
	chunk();
	advance(15_001);
	socket().clear();

	chunk();

	assert.deepEqual(socket().types(), ["input_audio_buffer.clear"]);
	assert.ok(
		logs.some((entry) => entry.event === "realtime.request_not_heard"),
	);
	socket().server({ type: "input_audio_buffer.speech_stopped" });
	assert.equal(socket().types().includes("response.create"), false);
});

test("Flux's end of turn answers at once, ending the turn the session is still hearing", async () => {
	const { engine, socket } = harness();
	await engine.start();
	socket().clear();
	socket().server({ type: "input_audio_buffer.speech_started" });
	engine.arm({ requester: "Dev One", speakerKey: "p1", endOfTurn: true });
	assert.deepEqual(socket().types(), [
		"input_audio_buffer.commit",
		"conversation.item.create",
		"response.create",
	]);
	// Who asked: the speaker. A request typed meanwhile waits its turn, and
	// the answer being made is still the speaker's.
	assert.equal(engine.requesterKey(), "p1");
	void engine.respondToChat("Dev Two", "What is next?", "p2");
	assert.equal(engine.requesterKey(), "p1");
});

test("a wake phrase heard while an answer plays is answered after it, opening with its asker's name, and the answer playing stays its own asker's", async () => {
	const h = harness();
	await h.engine.start();
	const responses = () =>
		h
			.socket()
			.types()
			.filter((type) => type === "response.create").length;
	h.engine.arm({ requester: "Dev One", speakerKey: "p1", endOfTurn: true });
	h.socket().server({ type: "response.created", response: { id: "resp_1" } });
	h.socket().server(audioDelta("resp_1", 9_600));
	h.socket().clear();

	h.engine.arm({ requester: "Dev Two", speakerKey: "p2", endOfTurn: true });
	assert.equal(responses(), 0, "the second request waits");
	assert.equal(h.engine.requesterKey(), "p1");
	assert.equal(h.engine.holdsFloor(), true);
	assert.equal(h.socket().types().includes("response.cancel"), false);

	h.socket().server(done("resp_1"));
	assert.equal(responses(), 1, "it starts once the first is done");
	// The first answer still plays: a stop now is still its asker's.
	assert.equal(h.engine.isPlaying(), true);
	assert.equal(h.engine.requesterKey(), "p1");
	assert.ok(
		systemTexts(h.socket()).includes(
			"Dev Two asked while you were answering. Start your answer with their name.",
		),
	);
});

test("each response logs its status, its output tokens and the audio it sent, with no transcript", async () => {
	const h = harness();
	await h.engine.start();
	h.engine.arm({ requester: null, speakerKey: "p1", endOfTurn: true });
	h.socket().server({ type: "response.created", response: { id: "resp_1" } });
	h.socket().server(audioDelta("resp_1", 4_800));
	h.socket().server(audioDelta("resp_1", 4_800));
	h.socket().server(done("resp_1"));

	assert.deepEqual(
		h.logs.filter((entry) => entry.event === "realtime.done"),
		[
			{
				event: "realtime.done",
				meta: {
					status: "completed",
					reason: null,
					outputAudioTokens: 60,
					outputTextTokens: 5,
					audioBytes: 9_600,
					audioMs: 200,
				},
			},
		],
	);
	assert.deepEqual(h.posted, [], "a whole answer posts nothing");
});

test("an answer cut at the output limit is logged as capped, and the meeting chat is told once", async () => {
	const h = harness();
	await h.engine.start();
	h.engine.arm({ requester: "Dev One", speakerKey: "p1", endOfTurn: true });
	h.socket().server({ type: "response.created", response: { id: "resp_1" } });
	h.socket().server(audioDelta("resp_1", 48_000));
	h.socket().server(
		done("resp_1", [], "incomplete", { reason: "max_output_tokens" }),
	);
	await flush();

	assert.deepEqual(
		h.logs.find((entry) => entry.event === "realtime.capped"),
		{ event: "realtime.capped", meta: { audioMs: 1_000 } },
	);
	assert.equal(
		h.logs.find((entry) => entry.event === "realtime.done")?.meta.reason,
		"max_output_tokens",
	);
	assert.equal(h.posted.length, 1);
	assert.match(h.posted[0] ?? "", /^\*\*Cut short\*\* · .*45-second limit/);
});

test("a post the bridge read aloud is noted in the conversation as said, each link by its title, with no response asked for", async () => {
	const { engine, socket } = harness();
	await engine.start();
	socket().clear();
	const release = engine.holdForRead(
		"Roadmap: https://fabric.example/app/projects/p?tab=stories\nContext: https://fabric.example/app/projects/p?tab=context",
		0,
	);
	assert.deepEqual(systemTexts(socket()), [], "nothing is said yet");
	release(true);
	const text = systemTexts(socket()).at(-1) ?? "";
	assert.match(text, /read aloud to the meeting, word for word/);
	assert.doesNotMatch(text, /your voice/, "Aura read it, not the voice");
	assert.match(text, /Roadmap\. Context\./);
	assert.doesNotMatch(text, /the link/);
	assert.doesNotMatch(text, /https?:/);
	assert.equal(socket().types().includes("response.create"), false);
});

test("Parlume's voice plays through the outlet, and a read held over it stops its audio and truncates to what was heard once it ends", async () => {
	const h = harness();
	await h.engine.start();
	h.engine.arm({ requester: null, speakerKey: "p1", endOfTurn: true });
	h.socket().server({ type: "response.created", response: { id: "resp_1" } });
	h.socket().server(audioDelta("resp_1", 9_600));
	h.socket().server(audioDelta("resp_1", 9_600));
	assert.deepEqual(h.enqueued, [9_600, 9_600]);
	assert.equal(h.engine.isPlaying(), true);
	h.socket().clear();
	// The outlet had 4,800 bytes (100 ms) still queued when it was cleared.
	h.engine.holdForRead("Here is F-12.", 4_800);
	assert.equal(h.engine.isPlaying(), false);
	assert.deepEqual(h.socket().sent, [], "the response is not cancelled");
	// Audio still arriving for the held response is not played.
	h.socket().server(audioDelta("resp_1", 4_800));
	assert.equal(h.enqueued.length, 2);
	h.socket().server(done("resp_1"));
	assert.deepEqual(h.socket().sent, [
		{
			type: "conversation.item.truncate",
			item_id: "item_resp_1",
			content_index: 0,
			audio_end_ms: 300,
		},
	]);
});

// A read aloud ("Hey Fabric, go P1") once cancelled the answer in progress;
// the ask_fabric call it made was dropped and Fabric never heard the request.
test("an answer held for a read runs on to its end, and the request it hands to Fabric is sent", async () => {
	const h = harness();
	await h.engine.start();
	h.engine.arm({ requester: "Dev One", speakerKey: "p1", endOfTurn: true });
	h.socket().server({ type: "response.created", response: { id: "resp_1" } });
	h.socket().server(audioDelta("resp_1", 9_600));
	h.socket().clear();

	h.engine.holdForRead("Here is F-12.", 4_800);
	h.socket().server(
		done("resp_1", [
			{
				type: "function_call",
				call_id: "call_1",
				name: "ask_fabric",
				arguments: JSON.stringify({ request: "Status of F-12?" }),
			},
		]),
	);
	await flush();

	assert.deepEqual(plain(h.jobs), [
		{
			job: "J1",
			request: "Status of F-12?",
			requester: "Dev One",
			requesterKey: "p1",
			generation: 7,
		},
	]);
	assert.equal(h.socket().types().includes("response.cancel"), false);
	assert.deepEqual(h.socket().sent[0], {
		type: "conversation.item.truncate",
		item_id: "item_resp_1",
		content_index: 0,
		audio_end_ms: 100,
	});
});

test("a stop after response.done, while the answer still plays, cancels and truncates it", async () => {
	const h = harness();
	await h.engine.start();
	h.engine.arm({ requester: "Dev One", speakerKey: "p1", endOfTurn: true });
	h.socket().server({ type: "response.created", response: { id: "resp_1" } });
	h.socket().server(audioDelta("resp_1", 9_600));
	h.socket().server(done("resp_1"));
	await flush();
	assert.equal(h.engine.isPlaying(), true, "the outlet is still draining");
	h.socket().clear();

	h.engine.silence(4_800);

	assert.equal(h.engine.isPlaying(), false);
	assert.deepEqual(h.socket().sent, [
		{ type: "response.cancel" },
		{
			type: "conversation.item.truncate",
			item_id: "item_resp_1",
			content_index: 0,
			audio_end_ms: 100,
		},
	]);
});

test("a read held after response.done only truncates: it cancels nothing", async () => {
	const h = harness();
	await h.engine.start();
	h.engine.arm({ requester: "Dev One", speakerKey: "p1", endOfTurn: true });
	h.socket().server({ type: "response.created", response: { id: "resp_1" } });
	h.socket().server(audioDelta("resp_1", 9_600));
	h.socket().server(done("resp_1"));
	await flush();
	h.socket().clear();

	h.engine.holdForRead("Here is F-12.", 0);

	assert.deepEqual(h.socket().types(), ["conversation.item.truncate"]);
});

test("a late stop's refused cancel does not drop the next answer being created", async () => {
	const h = harness();
	await h.engine.start();
	h.engine.arm({ requester: "Dev One", speakerKey: "p1", endOfTurn: true });
	h.socket().server({ type: "response.created", response: { id: "resp_1" } });
	h.socket().server(audioDelta("resp_1", 9_600));
	h.socket().server(done("resp_1"));
	await flush();
	h.engine.silence(0);
	h.engine.arm({ requester: "Dev Two", speakerKey: "p2", endOfTurn: true });
	assert.ok(h.socket().types().includes("response.create"));

	h.socket().server({
		type: "error",
		error: {
			code: "response_cancel_not_active",
			message: "Cancellation failed: no active response found",
		},
	});
	h.socket().server({ type: "response.created", response: { id: "resp_2" } });
	h.socket().server(audioDelta("resp_2", 4_800));

	assert.equal(h.engine.isResponding(), true);
	assert.deepEqual(h.enqueued, [9_600, 4_800]);
});

test("ask_fabric starts a Fabric job and answers at once; its result waits for the response in progress", async () => {
	const h = harness();
	await h.engine.start();
	h.engine.arm({ requester: "Dev One", speakerKey: "p1", endOfTurn: true });
	h.socket().server({ type: "response.created", response: { id: "resp_1" } });
	h.socket().clear();
	h.socket().server(
		done("resp_1", [
			{
				type: "function_call",
				call_id: "call_1",
				name: "ask_fabric",
				arguments: JSON.stringify({
					request: "Create a bug for the export",
				}),
			},
		]),
	);
	await flush();
	assert.deepEqual(plain(h.jobs), [
		{
			job: "J1",
			request: "Create a bug for the export",
			requester: "Dev One",
			// The speaker's key, so Fabric runs the job as the confirmed
			// participant who asked.
			requesterKey: "p1",
			generation: 7,
		},
	]);
	const output = h.socket().sent[0] as {
		item: { type: string; call_id: string; output: string };
	};
	assert.equal(output.item.type, "function_call_output");
	assert.equal(output.item.call_id, "call_1");
	assert.deepEqual(JSON.parse(output.item.output), {
		status: "started",
		job: "J1",
	});
	assert.equal(h.socket().types()[1], "response.create");
	assert.equal(h.engine.hasJob(7), true);
	assert.equal(h.engine.isResponding(), true);

	// The holding line is still being produced when the result arrives.
	h.socket().server({ type: "response.created", response: { id: "resp_2" } });
	h.socket().clear();
	assert.equal(
		h.engine.deliverResult({
			job: "J1",
			status: "completed",
			text: "Created B-12, Export fails.",
			chatTags: [],
		}),
		true,
	);
	assert.deepEqual(h.socket().sent, [], "nothing is injected mid-response");
	h.socket().server(done("resp_2"));
	assert.deepEqual(h.socket().types(), [
		"conversation.item.create",
		"response.create",
	]);
	assert.match(systemTexts(h.socket())[0], /Fabric finished J1/);
	assert.match(systemTexts(h.socket())[0], /Created B-12, Export fails\./);
	assert.equal(h.engine.hasJob(7), false);
	assert.equal(
		h.engine.deliverResult({
			job: "J1",
			status: "completed",
			text: "again",
			chatTags: [],
		}),
		false,
		"a result is spoken once",
	);
});

test("Parlume says it is on a Fabric job at most once every ten seconds", async () => {
	const h = harness();
	await h.engine.start();
	const askFabric = (callId: string) => ({
		type: "function_call",
		call_id: callId,
		name: "ask_fabric",
		arguments: JSON.stringify({ request: "More on P1" }),
	});
	const responses = () =>
		h
			.socket()
			.types()
			.filter((type) => type === "response.create").length;

	// The answer to the request spoke ("Sure, one moment") and started a job.
	h.engine.arm({ requester: "Dev One", speakerKey: "p1", endOfTurn: true });
	h.socket().server({ type: "response.created", response: { id: "resp_1" } });
	h.socket().server(audioDelta("resp_1", 4_800));
	h.socket().server(done("resp_1", [askFabric("call_1")]));
	await flush();
	assert.equal(h.jobs.length, 1);
	assert.equal(responses(), 1, "the job's start is not announced again");
	assert.ok(h.socket().types().includes("conversation.item.create"));

	// Asked again a few seconds later, the job is busy: nothing more is said.
	h.advance(4_000);
	h.socket().server({ type: "input_audio_buffer.speech_started" });
	h.engine.arm({ requester: "Dev One", speakerKey: "p1", endOfTurn: true });
	h.socket().server({ type: "response.created", response: { id: "resp_2" } });
	h.socket().server(done("resp_2", [askFabric("call_2")]));
	await flush();
	assert.equal(responses(), 2);

	// Ten seconds after the last holding line, it may say so once more.
	h.advance(10_000);
	h.socket().server({ type: "input_audio_buffer.speech_started" });
	h.engine.arm({ requester: "Dev One", speakerKey: "p1", endOfTurn: true });
	h.socket().server({ type: "response.created", response: { id: "resp_3" } });
	h.socket().server(done("resp_3", [askFabric("call_3")]));
	h.socket().server({ type: "input_audio_buffer.speech_stopped" });
	await flush();
	assert.equal(responses(), 4);
});

test("another participant's request while a Fabric job runs waits for it and is handed to Fabric next; the same asker's again is not", async () => {
	const h = harness();
	await h.engine.start();
	const askFabric = (callId: string, request: string) => ({
		type: "function_call",
		call_id: callId,
		name: "ask_fabric",
		arguments: JSON.stringify({ request }),
	});

	// Each tool call is answered in a response of its own, for the same asker.
	const ask = async (
		requester: string,
		speakerKey: string,
		id: string,
		request: string,
	) => {
		h.advance(2_000);
		h.engine.arm({ requester, speakerKey, endOfTurn: true });
		h.socket().server({ type: "response.created", response: { id } });
		h.socket().server(done(id, [askFabric(`call_${id}`, request)]));
		await flush();
		h.socket().server({
			type: "response.created",
			response: { id: `${id}_tool` },
		});
		h.socket().server(done(`${id}_tool`, []));
		await flush();
	};

	await ask("Dev One", "p1", "resp_1", "Open risks?");
	assert.equal(h.jobs.length, 1);
	await ask("Dev Two", "p2", "resp_2", "Who owns F-12?");
	await ask("Dev One", "p1", "resp_3", "Open risks?");

	assert.deepEqual(
		toolOutputs(h.socket()).map((output) => output.status),
		["started", "queued", "busy"],
	);
	assert.equal(h.jobs.length, 1, "nothing more is handed to Fabric yet");

	assert.equal(
		h.engine.deliverResult({
			job: "J1",
			status: "completed",
			text: "Two open risks.",
			chatTags: [],
		}),
		true,
	);
	await flush();

	assert.equal(h.jobs.length, 2);
	assert.equal(h.jobs[1]?.job, "J2");
	assert.equal(h.jobs[1]?.request, "Who owns F-12?");
	assert.equal(h.jobs[1]?.requester, "Dev Two");
	assert.equal(h.jobs[1]?.requesterKey, "p2");
	assert.equal(h.engine.hasJob(7), true);
});

test("a request the bridge resolved is not answered again when its wake phrase already was", async () => {
	const h = harness();
	await h.engine.start();
	h.socket().server({ type: "input_audio_buffer.speech_started" });
	h.engine.arm({ requester: "Dev One", speakerKey: "p1", endOfTurn: false });
	h.socket().server({ type: "input_audio_buffer.speech_stopped" });
	await afterPause();
	assert.equal(
		await h.engine.respondToRequest("Dev One", "p1", "More on P1"),
		false,
	);
	assert.equal(
		h
			.socket()
			.types()
			.filter((type) => type === "response.create").length,
		1,
	);

	// A new utterance resolved by the bridge is answered.
	h.socket().server({ type: "input_audio_buffer.speech_started" });
	void h.engine.respondToRequest("Dev One", "p1", "Say P2");
	h.socket().server({ type: "input_audio_buffer.speech_stopped" });
	h.socket().server({ type: "response.created", response: { id: "resp_1" } });
	h.socket().server(done("resp_1"));
	assert.equal(
		h
			.socket()
			.types()
			.filter((type) => type === "response.create").length,
		2,
	);
});

test("a job Fabric refuses is reported as not finished", async () => {
	const h = harness({ accept: false });
	await h.engine.start();
	h.engine.arm({ requester: null, speakerKey: "p1", endOfTurn: true });
	h.socket().server({ type: "response.created", response: { id: "resp_1" } });
	h.socket().server(
		done("resp_1", [
			{
				type: "function_call",
				call_id: "call_1",
				name: "ask_fabric",
				arguments: JSON.stringify({ request: "Status?" }),
			},
		]),
	);
	await flush();
	await flush();
	assert.equal(h.engine.hasJob(7), false);
	h.socket().server({ type: "response.created", response: { id: "resp_2" } });
	h.socket().server(done("resp_2"));
	assert.ok(
		systemTexts(h.socket()).some((text) =>
			text.startsWith("Fabric could not finish J1"),
		),
	);
});

test("a cancel ends the running job: its result is no longer spoken", async () => {
	const h = harness();
	await h.engine.start();
	h.engine.arm({ requester: null, speakerKey: "p1", endOfTurn: true });
	h.socket().server({ type: "response.created", response: { id: "resp_1" } });
	h.socket().server(
		done("resp_1", [
			{
				type: "function_call",
				call_id: "call_1",
				name: "ask_fabric",
				arguments: JSON.stringify({ request: "Status?" }),
			},
		]),
	);
	await flush();
	h.engine.silence(0);
	assert.equal(h.engine.hasJob(7), false);
	assert.equal(
		h.engine.deliverResult({
			job: "J1",
			status: "completed",
			text: "Done.",
			chatTags: [],
		}),
		false,
	);
});

test("a voice post the chat already shows may be called posted", async () => {
	const h = harness({ shown: true });
	await h.engine.start();
	h.engine.arm({ requester: null, speakerKey: "p1", endOfTurn: true });
	h.socket().server({ type: "response.created", response: { id: "resp_1" } });
	h.socket().clear();
	h.socket().server(
		done("resp_1", [
			{
				type: "function_call",
				call_id: "call_1",
				name: "post_to_chat",
				arguments: JSON.stringify({ text: "Open features: F-12." }),
			},
		]),
	);
	await flush();
	assert.deepEqual(toolOutputs(h.socket()), [
		{
			posted: true,
			tag: "P3",
			instruction:
				"The meeting chat shows it now: you may say it is there.",
		},
	]);
});

test("post_to_chat and read_chat answer from the bridge's chat", async () => {
	const h = harness();
	await h.engine.start();
	h.engine.arm({ requester: null, speakerKey: "p1", endOfTurn: true });
	h.socket().server({ type: "response.created", response: { id: "resp_1" } });
	h.socket().clear();
	h.socket().server(
		done("resp_1", [
			{
				type: "function_call",
				call_id: "call_1",
				name: "post_to_chat",
				arguments: JSON.stringify({
					text: "Open features: F-12 and F-13.",
				}),
			},
			{
				type: "function_call",
				call_id: "call_2",
				name: "read_chat",
				arguments: "{}",
			},
		]),
	);
	await flush();
	const outputs = h
		.socket()
		.sent.filter((event) => event.type === "conversation.item.create")
		.map((event) => JSON.parse((event.item as { output: string }).output));
	assert.deepEqual(outputs, [
		{
			posted: true,
			tag: "P3",
			instruction:
				"The chat has not shown it yet: say you are posting it there, never that it is there.",
		},
		{ messages: [{ from: "Sam", text: "Link?" }] },
	]);
	assert.deepEqual(h.posted, ["Open features: F-12 and F-13."]);
});

/** The function outputs the session was given, parsed. */
function toolOutputs(socket: FakeSocket): Array<Record<string, unknown>> {
	return socket.sent
		.filter(
			(event) =>
				event.type === "conversation.item.create" &&
				(event.item as { type?: string }).type ===
					"function_call_output",
		)
		.map((event) => JSON.parse((event.item as { output: string }).output));
}

function postToChat(
	h: ReturnType<typeof harness>,
	responseId: string,
	text: string,
) {
	h.socket().server({
		type: "response.created",
		response: { id: responseId },
	});
	h.socket().server(
		done(responseId, [
			{
				type: "function_call",
				call_id: `call_${responseId}`,
				name: "post_to_chat",
				arguments: JSON.stringify({ text }),
			},
		]),
	);
}

// The voice posted repository and project page addresses it wrote itself,
// without the lookup Fabric runs for typed and spoken requests.
test("post_to_chat refuses an address the voice wrote itself and points it at ask_fabric", async () => {
	const h = harness();
	await h.engine.start();
	h.engine.arm({ requester: null, speakerKey: "p1", endOfTurn: true });
	h.socket().clear();
	postToChat(
		h,
		"resp_1",
		"Repository: github.com/example-org/example-repo\nRoadmap: https://fabric.example/app/projects/p?tab=stories",
	);
	await flush();

	assert.deepEqual(h.posted, []);
	const [output] = toolOutputs(h.socket());
	assert.equal(output?.posted, false);
	assert.equal(output?.reason, "address_not_from_fabric");
	assert.match(String(output?.instruction), /ask_fabric/);
	assert.equal(
		h.logs.find((entry) => entry.event === "realtime.chat_address_refused")
			?.meta.addresses,
		2,
	);
	assert.equal(
		h.socket().types().at(-1),
		"response.create",
		"the voice is asked to answer the refusal",
	);
});

test("post_to_chat posts an address that a Fabric result or the meeting chat gave", async () => {
	const h = harness({
		chat: [
			{
				from: "Sam",
				text: "Spec is at https://docs.example.com/spec-12, take a look.",
			},
		],
	});
	await h.engine.start();
	h.engine.arm({ requester: null, speakerKey: "p1", endOfTurn: true });
	h.socket().server({ type: "response.created", response: { id: "resp_1" } });
	h.socket().server(
		done("resp_1", [
			{
				type: "function_call",
				call_id: "call_1",
				name: "ask_fabric",
				arguments: JSON.stringify({ request: "Link the roadmap" }),
			},
		]),
	);
	await flush();
	h.socket().server({ type: "response.created", response: { id: "resp_2" } });
	h.socket().server(done("resp_2"));
	h.engine.deliverResult({
		job: "J1",
		status: "completed",
		text: "Roadmap — https://fabric.example/app/projects/p?tab=stories.",
		chatTags: [],
	});
	h.socket().server({ type: "response.created", response: { id: "resp_3" } });
	h.socket().server(done("resp_3"));
	h.engine.arm({ requester: null, speakerKey: "p2", endOfTurn: true });
	postToChat(
		h,
		"resp_4",
		"Roadmap: https://fabric.example/app/projects/p?tab=stories\nSpec: https://docs.example.com/spec-12",
	);
	await flush();

	assert.deepEqual(h.posted, [
		"Roadmap: https://fabric.example/app/projects/p?tab=stories\nSpec: https://docs.example.com/spec-12",
	]);
});

test("a job's answer records when it was first heard and when it finished playing", async () => {
	let drain = () => {};
	const h = harness({
		drained: () =>
			new Promise<void>((resolve) => {
				drain = resolve;
			}),
	});
	await h.engine.start();
	h.engine.arm({ requester: null, speakerKey: "p1", endOfTurn: true });
	h.socket().server({ type: "response.created", response: { id: "resp_1" } });
	h.socket().server(
		done("resp_1", [
			{
				type: "function_call",
				call_id: "call_1",
				name: "ask_fabric",
				arguments: JSON.stringify({ request: "Status of F-12?" }),
			},
		]),
	);
	await flush();
	h.socket().server({ type: "response.created", response: { id: "resp_2" } });
	h.socket().server(done("resp_2"));
	h.engine.deliverResult({
		job: "J1",
		status: "completed",
		text: "F-12 is in review.",
		chatTags: [],
		turnId: "turn-1",
	});
	h.socket().server({ type: "response.created", response: { id: "resp_3" } });
	h.advance(700);
	h.socket().server(audioDelta("resp_3", 9_600));
	h.advance(1_800);
	h.socket().server(done("resp_3"));
	await flush();
	assert.deepEqual(h.spoken, [], "not before the outlet has played it");

	h.advance(2_500);
	drain();
	await flush();
	assert.deepEqual(h.spoken, [
		{
			turnId: "turn-1",
			firstAudioAt: 1_700,
			spokenAt: 6_000,
			interrupted: false,
		},
	]);
});

test("a job's answer cut short is recorded as interrupted, not spoken", async () => {
	const h = harness({ drained: async () => {} });
	await h.engine.start();
	h.engine.arm({ requester: null, speakerKey: "p1", endOfTurn: true });
	h.socket().server({ type: "response.created", response: { id: "resp_1" } });
	h.socket().server(
		done("resp_1", [
			{
				type: "function_call",
				call_id: "call_1",
				name: "ask_fabric",
				arguments: JSON.stringify({ request: "Status of F-12?" }),
			},
		]),
	);
	await flush();
	h.socket().server({ type: "response.created", response: { id: "resp_2" } });
	h.socket().server(done("resp_2"));
	h.engine.deliverResult({
		job: "J1",
		status: "completed",
		text: "F-12 is in review.",
		chatTags: [],
		turnId: "turn-1",
	});
	h.socket().server({ type: "response.created", response: { id: "resp_3" } });
	h.socket().server(audioDelta("resp_3", 9_600));
	h.engine.silence(4_800);
	h.socket().server(done("resp_3", [], "cancelled"));
	await flush();

	assert.deepEqual(h.spoken, [
		{
			turnId: "turn-1",
			firstAudioAt: 1_000,
			spokenAt: null,
			interrupted: true,
		},
	]);
});

test("a read aloud cuts the answer being spoken, and the voice starts nothing until the latest read is released", async () => {
	const h = harness();
	await h.engine.start();
	h.engine.arm({ requester: null, speakerKey: "p1", endOfTurn: true });
	h.socket().server({ type: "response.created", response: { id: "resp_1" } });
	h.socket().server(audioDelta("resp_1", 9_600));
	h.socket().clear();

	// Two "go" commands, nothing awaited between them.
	const first = h.engine.holdForRead("Here is F-12.", 0);
	const second = h.engine.holdForRead("Here is F-13.", 0);
	assert.equal(h.engine.isPlaying(), false, "the answer is no longer heard");
	assert.equal(
		h.socket().types().includes("response.cancel"),
		false,
		"the answer runs on, unheard",
	);

	h.socket().server(done("resp_1"));
	assert.equal(
		h.socket().types().includes("conversation.item.truncate"),
		true,
	);
	h.engine.arm({ requester: null, speakerKey: "p2", endOfTurn: true });
	first(false);
	assert.equal(
		h.socket().types().includes("response.create"),
		false,
		"an earlier read's release leaves the later read holding the voice",
	);
	second(true);
	assert.doesNotMatch(systemTexts(h.socket()).join("\n"), /Here is F-12\./);
	assert.equal(h.socket().types().at(-1), "response.create");
});

function startJob(h: ReturnType<typeof harness>) {
	h.engine.arm({ requester: null, speakerKey: "p1", endOfTurn: true });
	h.socket().server({ type: "response.created", response: { id: "resp_1" } });
	h.socket().server(
		done("resp_1", [
			{
				type: "function_call",
				call_id: "call_1",
				name: "ask_fabric",
				arguments: JSON.stringify({ request: "Status of F-12?" }),
			},
		]),
	);
}

// "go" once cancelled the meeting turn, so a running job stopped mid-write.
test("a read aloud stops only the voice: a running Fabric job carries on and its answer is spoken after the read", async () => {
	const h = harness();
	await h.engine.start();
	startJob(h);
	await flush();
	h.socket().server({ type: "response.created", response: { id: "resp_2" } });
	h.socket().server(audioDelta("resp_2", 4_800));
	h.socket().clear();

	const release = h.engine.holdForRead("Here is F-12.", 0);

	assert.equal(h.socket().types().includes("response.cancel"), false);
	assert.equal(h.engine.hasJob(7), true, "the job still runs");
	h.socket().server(done("resp_2"));
	assert.equal(
		h.engine.deliverResult({
			job: "J1",
			status: "completed",
			text: "F-12 is in review.",
			chatTags: [],
		}),
		true,
	);
	assert.equal(
		h.socket().types().includes("response.create"),
		false,
		"the result waits for the read",
	);
	release(true);
	assert.match(systemTexts(h.socket()).at(-2) ?? "", /Here is F-12\./);
	assert.match(systemTexts(h.socket()).at(-1) ?? "", /Fabric finished J1/);
	assert.equal(h.socket().types().at(-1), "response.create");
});

test("an answer already queued when a read starts is still spoken after it", async () => {
	const h = harness();
	await h.engine.start();
	startJob(h);
	await flush();
	h.socket().server({ type: "response.created", response: { id: "resp_2" } });
	h.engine.deliverResult({
		job: "J1",
		status: "completed",
		text: "F-12 is in review.",
		chatTags: [],
		turnId: "turn-1",
	});
	h.socket().clear();

	const release = h.engine.holdForRead("Here is F-12.", 0);
	h.socket().server(done("resp_2", [], "cancelled"));

	assert.equal(h.socket().types().includes("response.create"), false);
	// Someone spoke over the read: what was cut short is not noted as said.
	release(false);
	assert.equal(systemTexts(h.socket()).length, 1);
	assert.match(systemTexts(h.socket())[0], /F-12 is in review\./);
	assert.equal(h.socket().types().at(-1), "response.create");
	assert.deepEqual(h.spoken, [], "the answer was not cut short");
});

// With the bot's outlet gone when a response ended, Parlume stayed "playing"
// and every later meeting turn's answer waited for audio that never ended.
test("with no outlet left when a response ends, a meeting turn's answer still starts", async () => {
	const h = harness();
	await h.engine.start();
	startJob(h);
	await flush();
	h.socket().server({ type: "response.created", response: { id: "resp_2" } });
	h.socket().server(audioDelta("resp_2", 9_600));
	assert.equal(h.engine.isPlaying(), true);

	h.dropOutlet();
	h.socket().server(done("resp_2"));
	assert.equal(h.engine.isPlaying(), false);
	h.engine.deliverResult({
		job: "J1",
		status: "completed",
		text: "F-12 is in review.",
		chatTags: [],
		turnId: "turn-1",
	});

	assert.match(systemTexts(h.socket()).at(-1) ?? "", /F-12 is in review\./);
	assert.equal(h.socket().types().at(-1), "response.create");
});

test("after the session drops mid-answer, a meeting turn's answer starts once the queued audio has played", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const h = harness({ drained: async () => {} });
	await h.engine.start();
	startJob(h);
	await flush();
	h.socket().server({ type: "response.created", response: { id: "resp_2" } });
	h.socket().server(audioDelta("resp_2", 9_600));

	h.socket().drop();
	await flush();
	assert.equal(h.engine.isPlaying(), false);
	t.mock.timers.tick(1_000);
	await flush();
	await flush();
	h.engine.deliverResult({
		job: "J1",
		status: "completed",
		text: "F-12 is in review.",
		chatTags: [],
		turnId: "turn-1",
	});

	assert.equal(h.sockets.length, 2);
	assert.match(systemTexts(h.socket()).at(-1) ?? "", /F-12 is in review\./);
	assert.equal(h.socket().types().at(-1), "response.create");
});

test("an answer dropped before it was spoken is recorded as interrupted", async () => {
	for (const end of [
		(h: ReturnType<typeof harness>) => h.engine.silence(0),
		(h: ReturnType<typeof harness>) => h.engine.stop("meeting_ended"),
	]) {
		const h = harness();
		await h.engine.start();
		startJob(h);
		await flush();
		h.socket().server({
			type: "response.created",
			response: { id: "resp_2" },
		});
		h.engine.deliverResult({
			job: "J1",
			status: "completed",
			text: "F-12 is in review.",
			chatTags: [],
			turnId: "turn-1",
		});

		end(h);

		assert.deepEqual(h.spoken, [
			{
				turnId: "turn-1",
				firstAudioAt: null,
				spokenAt: null,
				interrupted: true,
			},
		]);
	}
});

// Told nothing about the chat, the voice said Fabric had posted a link that
// was never posted.
test("a result tells the voice plainly whether any of it is in the meeting chat", async () => {
	const h = harness();
	await h.engine.start();
	startJob(h);
	await flush();
	h.socket().server({ type: "response.created", response: { id: "resp_2" } });
	h.socket().server(done("resp_2"));
	h.engine.deliverResult({
		job: "J1",
		status: "completed",
		text: "F-12 is in review.",
		chatTags: [],
	});
	const result = systemTexts(h.socket()).at(-1) ?? "";
	assert.match(result, /Nothing from this result is in the meeting chat/);
	assert.doesNotMatch(result, /being posted to the meeting chat/);

	h.socket().server({ type: "response.created", response: { id: "resp_3" } });
	h.socket().server(done("resp_3"));
	h.engine.arm({ requester: null, speakerKey: "p2", endOfTurn: true });
	h.socket().server({ type: "response.created", response: { id: "resp_4" } });
	h.socket().server(
		done("resp_4", [
			{
				type: "function_call",
				call_id: "call_4",
				name: "ask_fabric",
				arguments: JSON.stringify({ request: "Link the roadmap" }),
			},
		]),
	);
	await flush();
	h.engine.deliverResult({
		job: "J2",
		status: "completed",
		text: "Roadmap: https://app.example.com/projects/p?tab=stories",
		chatTags: ["P4"],
	});
	const linked = systemTexts(h.socket()).at(-1) ?? "";
	// Queued is not shown: a chat the organizer turned off never shows it.
	assert.match(
		linked,
		/It is also being posted to the meeting chat as P4; do not post it again\./,
	);
	assert.match(linked, /never that it is there/);
	assert.doesNotMatch(linked, /It is also in the meeting chat/);
	assert.doesNotMatch(linked, /Nothing from this result/);

	// The answer giving that result posts it again: refused, nothing posted.
	const postedBefore = h.posted.length;
	h.socket().server({ type: "response.created", response: { id: "resp_5" } });
	h.socket().server(
		done("resp_5", [
			{
				type: "function_call",
				call_id: "call_5",
				name: "post_to_chat",
				arguments: JSON.stringify({
					text: "Roadmap: https://app.example.com/projects/p?tab=stories",
				}),
			},
		]),
	);
	await flush();
	assert.equal(h.posted.length, postedBefore);
	assert.equal(toolOutputs(h.socket()).at(-1)?.reason, "already_posted");
});

// A job's answer that only posted to the chat reported no times, and the
// spoken line after the post, which the meeting did hear, reported none.
test("a job's answer that only posts to the chat is timed by the line spoken after the post", async () => {
	const h = harness({ drained: async () => {} });
	await h.engine.start();
	startJob(h);
	await flush();
	h.socket().server({ type: "response.created", response: { id: "resp_2" } });
	h.socket().server(done("resp_2"));
	h.engine.deliverResult({
		job: "J1",
		status: "completed",
		text: "Roadmap: https://app.example.com/projects/p?tab=stories",
		chatTags: [],
		turnId: "turn-1",
	});
	h.socket().server({ type: "response.created", response: { id: "resp_3" } });
	h.socket().server(
		done("resp_3", [
			{
				type: "function_call",
				call_id: "call_3",
				name: "post_to_chat",
				arguments: JSON.stringify({
					text: "Roadmap: https://app.example.com/projects/p?tab=stories",
				}),
			},
		]),
	);
	await flush();
	assert.deepEqual(h.posted, [
		"Roadmap: https://app.example.com/projects/p?tab=stories",
	]);
	assert.deepEqual(h.spoken, [], "the silent answer reports nothing");

	h.socket().server({ type: "response.created", response: { id: "resp_4" } });
	h.advance(700);
	h.socket().server(audioDelta("resp_4", 9_600));
	h.advance(1_000);
	h.socket().server(done("resp_4"));
	await flush();
	assert.deepEqual(h.spoken, [
		{
			turnId: "turn-1",
			firstAudioAt: 1_700,
			spokenAt: 2_700,
			interrupted: false,
		},
	]);
});

// The next answer started while earlier speech was still playing, so its
// first audio was stamped when it was queued, seconds before it was heard.
test("a job's answer waits for earlier speech to finish playing, and is timed from then", async () => {
	let drain = () => {};
	const h = harness({
		drained: () =>
			new Promise<void>((resolve) => {
				drain = resolve;
			}),
	});
	await h.engine.start();
	const responses = () =>
		h
			.socket()
			.types()
			.filter((type) => type === "response.create").length;
	startJob(h);
	await flush();
	// The holding line is still playing when the result arrives.
	h.socket().server({ type: "response.created", response: { id: "resp_2" } });
	h.socket().server(audioDelta("resp_2", 9_600));
	h.socket().server(done("resp_2"));
	h.engine.deliverResult({
		job: "J1",
		status: "completed",
		text: "F-12 is in review.",
		chatTags: [],
		turnId: "turn-1",
	});
	assert.equal(responses(), 2, "the answer waits for the holding line");

	h.advance(2_000);
	drain();
	await flush();
	assert.equal(responses(), 3);
	assert.match(systemTexts(h.socket()).at(-1) ?? "", /F-12 is in review\./);
	h.socket().server({ type: "response.created", response: { id: "resp_3" } });
	h.advance(300);
	h.socket().server(audioDelta("resp_3", 9_600));
	h.socket().server(done("resp_3"));
	h.advance(1_000);
	drain();
	await flush();
	assert.deepEqual(h.spoken, [
		{
			turnId: "turn-1",
			firstAudioAt: 3_300,
			spokenAt: 4_300,
			interrupted: false,
		},
	]);
});

// A typed "go P8" cut off a short Fabric result that was in no chat post,
// and the result was never given.
test("a Fabric result a read cuts off is given again after the read, which reports the turn", async () => {
	let drain = () => {};
	const h = harness({
		drained: () =>
			new Promise<void>((resolve) => {
				drain = resolve;
			}),
	});
	await h.engine.start();
	startJob(h);
	await flush();
	h.socket().server({ type: "response.created", response: { id: "resp_2" } });
	h.socket().server(done("resp_2"));
	h.engine.deliverResult({
		job: "J1",
		status: "completed",
		text: "F-12 is in review.",
		chatTags: [],
		turnId: "turn-1",
	});
	// The result is generated and still playing when the read is asked for.
	h.socket().server({ type: "response.created", response: { id: "resp_3" } });
	h.socket().server(audioDelta("resp_3", 9_600));
	h.socket().server(done("resp_3"));
	h.socket().clear();

	const release = h.engine.holdForRead("Here is F-13.", 4_800);
	drain();
	await flush();
	assert.equal(h.socket().types().includes("response.create"), false);
	release(true);
	assert.match(systemTexts(h.socket()).at(-2) ?? "", /Here is F-13\./);
	const again = systemTexts(h.socket()).at(-1) ?? "";
	assert.match(again, /give Fabric's result again/);
	assert.match(again, /F-12 is in review\./);
	assert.equal(h.socket().types().at(-1), "response.create");
	assert.deepEqual(h.spoken, [], "the answer cut off reports nothing");

	h.socket().server({ type: "response.created", response: { id: "resp_4" } });
	h.advance(500);
	h.socket().server(audioDelta("resp_4", 9_600));
	h.socket().server(done("resp_4"));
	h.advance(1_000);
	drain();
	await flush();
	assert.deepEqual(h.spoken, [
		{
			turnId: "turn-1",
			firstAudioAt: 1_500,
			spokenAt: 2_500,
			interrupted: false,
		},
	]);
});

test("a Fabric result still being written when a read cuts it is given again after the read", async () => {
	const h = harness();
	await h.engine.start();
	startJob(h);
	await flush();
	h.socket().server({ type: "response.created", response: { id: "resp_2" } });
	h.socket().server(done("resp_2"));
	h.engine.deliverResult({
		job: "J1",
		status: "completed",
		text: "F-12 is in review.",
		chatTags: [],
		turnId: "turn-1",
	});
	h.socket().server({ type: "response.created", response: { id: "resp_3" } });
	h.socket().server(audioDelta("resp_3", 9_600));
	h.socket().clear();

	const release = h.engine.holdForRead("Here is F-13.", 0);
	h.socket().server(done("resp_3"));
	assert.equal(h.socket().types().includes("response.create"), false);
	release(true);

	assert.match(systemTexts(h.socket()).at(-2) ?? "", /Here is F-13\./);
	assert.match(systemTexts(h.socket()).at(-1) ?? "", /F-12 is in review\./);
	assert.equal(h.socket().types().at(-1), "response.create");
});

// A spoken "go P8" while a request was being handed to Fabric was answered as
// a request ("I'm still on the earlier request") and the post was never read.
// A response asked to read the post is not bound to its words; now no
// response reads it at all.
test("a read asked for while a request is handed to Fabric asks the model for nothing, and Fabric's answer follows", async () => {
	const h = harness({ drained: async () => {} });
	await h.engine.start();
	h.engine.arm({ requester: "Dev One", speakerKey: "p1", endOfTurn: true });
	h.socket().server({ type: "response.created", response: { id: "resp_1" } });
	h.socket().server(audioDelta("resp_1", 4_800));
	h.socket().clear();

	// The bridge resolved a spoken "Hey Fabric, go P1".
	const release = h.engine.holdForRead("Here is F-12.", 0);
	h.socket().server(
		done("resp_1", [
			{
				type: "function_call",
				call_id: "call_1",
				name: "ask_fabric",
				arguments: JSON.stringify({ request: "Status of F-12?" }),
			},
		]),
	);
	await flush();

	assert.equal(h.jobs.length, 1, "the request reaches Fabric");
	assert.equal(
		h.socket().types().includes("response.create"),
		false,
		"no response is asked to read the post",
	);
	release(true);
	await flush();
	h.engine.deliverResult({
		job: "J1",
		status: "completed",
		text: "F-12 is in review.",
		chatTags: [],
		turnId: "turn-1",
	});

	assert.match(systemTexts(h.socket()).at(-1) ?? "", /F-12 is in review\./);
	assert.equal(h.socket().types().at(-1), "response.create");
});

test("after the bridge restarts, the voice may still post an address a Fabric result gave, however restated", async () => {
	const before = harness({ chat: [] });
	await before.engine.start();
	startJob(before);
	await flush();
	before
		.socket()
		.server({ type: "response.created", response: { id: "resp_2" } });
	before.socket().server(done("resp_2"));
	before.engine.deliverResult({
		job: "J1",
		status: "completed",
		text: "Roadmap: https://app.example.com/projects/p?tab=stories.",
		chatTags: [],
	});
	const saved = before.contexts.at(-1);
	assert.deepEqual(plain(saved).addresses, [
		"app.example.com/projects/p?tab=stories",
	]);

	const after = harness({ chat: [] });
	after.engine.restore(saved);
	await after.engine.start();
	after.engine.arm({ requester: null, speakerKey: "p1", endOfTurn: true });
	postToChat(
		after,
		"resp_1",
		"Roadmap: APP.example.com/projects/p?tab=stories",
	);
	await flush();

	assert.deepEqual(after.posted, [
		"Roadmap: APP.example.com/projects/p?tab=stories",
	]);
});

test("every response's usage is reported, cached tokens split out", async () => {
	const h = harness();
	await h.engine.start();
	h.engine.arm({ requester: null, speakerKey: "p1", endOfTurn: true });
	h.socket().server({ type: "response.created", response: { id: "resp_1" } });
	h.socket().server(done("resp_1"));
	assert.deepEqual(plain(h.usage), [
		{
			inputTextTokens: 50,
			inputAudioTokens: 100,
			cachedTextTokens: 50,
			cachedAudioTokens: 400,
			outputTextTokens: 5,
			outputAudioTokens: 60,
		},
	]);
});

test("a dropped session reconnects with what the meeting said so far", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const h = harness();
	await h.engine.start();
	h.engine.noteLine("Dev One", "We ship on Friday.");
	h.socket().drop();
	assert.equal(h.engine.active, true, "still the meeting's voice");
	t.mock.timers.tick(1_000);
	await flush();
	await flush();
	assert.equal(h.sockets.length, 2);
	assert.equal(h.socket().types()[0], "session.update");
	assert.match(systemTexts(h.socket())[0], /Dev One: We ship on Friday\./);
	assert.ok(h.logs.some((entry) => entry.event === "realtime.reconnect"));
});

test("after the bridge restarts, the voice resumes the meeting and still speaks a running job's result", async () => {
	const before = harness();
	await before.engine.start();
	before.engine.noteLine("Dev One", "We ship on Friday.");
	before.engine.arm({ requester: null, speakerKey: "p1", endOfTurn: true });
	before
		.socket()
		.server({ type: "response.created", response: { id: "resp_1" } });
	before.socket().server(
		done("resp_1", [
			{
				type: "function_call",
				call_id: "call_1",
				name: "ask_fabric",
				arguments: JSON.stringify({ request: "Status?" }),
			},
		]),
	);
	await flush();
	const saved = before.contexts.at(-1);
	assert.deepEqual(saved, {
		lines: ["Dev One: We ship on Friday."],
		jobs: [
			{
				job: "J1",
				generation: 7,
				requester: { name: null, key: "p1" },
			},
		],
		jobCounter: 1,
		addresses: [],
	});

	const after = harness();
	after.engine.restore(saved);
	await after.engine.start();
	const seed = systemTexts(after.socket())[0];
	assert.match(seed, /Dev One: We ship on Friday\./);
	assert.match(seed, /still working on J1/);
	assert.equal(
		after.engine.deliverResult({
			job: "J1",
			status: "completed",
			text: "All green.",
			chatTags: [],
		}),
		true,
	);
	assert.deepEqual(after.contexts.at(-1), {
		lines: ["Dev One: We ship on Friday."],
		jobs: [],
		jobCounter: 1,
		addresses: [],
	});
});

test("after repeated failures to reconnect the meeting falls back to classic", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	let opens = 0;
	const first = new FakeSocket();
	const h = harness({
		connect: async () => {
			opens++;
			if (opens === 1) {
				return first;
			}
			throw new Error("unreachable");
		},
	});
	await h.engine.start();
	first.drop();
	for (const delay of [1_000, 3_000, 10_000]) {
		t.mock.timers.tick(delay);
		await flush();
		await flush();
	}
	assert.deepEqual(h.fallbacks, ["reconnect_failed"]);
	assert.equal(h.engine.active, false);
});

test("sessions that close as soon as they open fall back to classic", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const h = harness();
	await h.engine.start();
	h.socket().drop();
	for (const delay of [1_000, 3_000, 10_000]) {
		t.mock.timers.tick(delay);
		await flush();
		await flush();
		h.socket().drop();
	}
	assert.equal(h.sockets.length, 4);
	assert.deepEqual(h.fallbacks, ["reconnect_failed"]);
	assert.equal(h.engine.active, false);
});

test("a session that held for a while starts its reconnects afresh", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const h = harness();
	await h.engine.start();
	for (let drop = 0; drop < 5; drop++) {
		h.advance(60_000);
		h.socket().drop();
		t.mock.timers.tick(1_000);
		await flush();
		await flush();
	}
	assert.equal(h.sockets.length, 6);
	assert.deepEqual(h.fallbacks, []);
	assert.equal(h.engine.active, true);
});

test("a fresh session takes over before the 60-minute limit", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const h = harness();
	await h.engine.start();
	t.mock.timers.tick(55 * 60 * 1000);
	await flush();
	await flush();
	assert.equal(h.sockets.length, 2);
	assert.equal(h.sockets[0].closed, true);
	assert.ok(
		h.logs.some(
			(entry) =>
				entry.event === "realtime.reconnect" &&
				entry.meta.reason === "session_limit",
		),
	);
});

// On staging, the bridge's own commit at the end of a meeting's first request
// came after OpenAI's turn detection had committed it. The "commit empty"
// error dropped the wake answer being created, and its ask_fabric call was
// never run: the request went unanswered, and the voice turned every later
// request away as still running.
test("an input audio error does not drop the answer being created", async () => {
	const h = harness();
	await h.engine.start();
	h.engine.arm({ requester: null, speakerKey: "p1", endOfTurn: true });
	assert.ok(h.socket().types().includes("response.create"));

	h.socket().server({
		type: "error",
		error: {
			type: "invalid_request_error",
			code: "input_audio_buffer_commit_empty",
			message: "Error committing input audio buffer: buffer is empty.",
		},
	});
	h.socket().server({ type: "response.created", response: { id: "resp_1" } });
	h.socket().server(
		done("resp_1", [
			{
				type: "function_call",
				call_id: "call_1",
				name: "ask_fabric",
				arguments: JSON.stringify({
					request: "Post the roadmap link.",
				}),
			},
		]),
	);
	await flush();

	assert.equal(h.jobs.length, 1);
	assert.equal(h.jobs[0].request, "Post the roadmap link.");
});

test("a completed response the bridge lost track of still has its calls answered", async () => {
	const h = harness();
	await h.engine.start();
	h.engine.arm({ requester: null, speakerKey: "p1", endOfTurn: true });
	// An error about the response itself: the bridge stops tracking it.
	h.socket().server({
		type: "error",
		error: { code: "invalid_value", message: "Refused." },
	});
	h.socket().clear();

	h.socket().server({ type: "response.created", response: { id: "resp_9" } });
	h.socket().server(
		done("resp_9", [
			{
				type: "function_call",
				call_id: "call_9",
				name: "ask_fabric",
				arguments: JSON.stringify({ request: "Status of F-12?" }),
			},
		]),
	);
	await flush();

	assert.equal(h.jobs.length, 1, "the request reaches Fabric");
	// Answered, so the call does not read as a job still running.
	assert.deepEqual(toolOutputs(h.socket()), [
		{ status: "started", job: "J1" },
	]);
});

// A dropped session lost the rest of the answer it was giving: the meeting
// heard half of it and nothing more.
test("an answer its session dropped goes on in the next session from just after what was heard", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const h = harness();
	await h.engine.start();
	h.engine.arm({ requester: null, speakerKey: "p1", endOfTurn: true });
	h.socket().server({ type: "response.created", response: { id: "resp_1" } });
	h.socket().server(transcriptDelta("resp_1", "F-12 is in review. "));
	h.socket().server(audioDelta("resp_1", 9_600));

	h.socket().drop();
	await pass(t, h, 1_000);

	assert.equal(h.sockets.length, 2);
	const resume = systemTexts(h.socket()).at(-1) ?? "";
	assert.match(resume, /<heard>\nF-12 is in review\.\n<\/heard>/);
	assert.match(resume, /Do not repeat what was heard/);
	assert.equal(lastResponseKind(h.socket()), "resume");
	const logged = h.logs.find((entry) => entry.event === "speech.resumed");
	assert.deepEqual(logged?.meta, {
		cause: "dropped",
		kind: "wake",
		gapMs: 1_000,
		lostMs: 0,
		heardChars: 19,
	});
});

test("an answer no session resumes within 15 seconds goes to the meeting chat, a Fabric result whole", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const first = new FakeSocket();
	let opens = 0;
	// The first session opens; the one after it never does.
	const h = harness({
		connect: () =>
			opens++ === 0
				? Promise.resolve(first)
				: new Promise<FakeSocket>(() => {}),
	});
	await h.engine.start();
	h.engine.arm({ requester: null, speakerKey: "p1", endOfTurn: true });
	first.server({ type: "response.created", response: { id: "resp_1" } });
	first.server(
		done("resp_1", [
			{
				type: "function_call",
				call_id: "call_1",
				name: "ask_fabric",
				arguments: JSON.stringify({ request: "Status of F-12?" }),
			},
		]),
	);
	await flush();
	first.server({ type: "response.created", response: { id: "resp_2" } });
	first.server(done("resp_2"));
	h.engine.deliverResult({
		job: "J1",
		status: "completed",
		text: "F-12 is in review. It ships on Friday.",
		chatTags: [],
		turnId: "turn-1",
	});
	first.server({ type: "response.created", response: { id: "resp_3" } });
	first.server(transcriptDelta("resp_3", "F-12 is in review. "));
	first.server(audioDelta("resp_3", 9_600));

	first.drop();
	await pass(t, h, 14_000);
	assert.equal(
		h.posted.some((text) => text.includes("Friday")),
		false,
		"the resume still has time to start",
	);
	await pass(t, h, 1_000);

	assert.ok(h.posted.includes("F-12 is in review. It ships on Friday."));
	assert.deepEqual(h.spoken, [
		{
			turnId: "turn-1",
			firstAudioAt: null,
			spokenAt: null,
			interrupted: true,
		},
	]);
	assert.ok(h.logs.some((entry) => entry.event === "realtime.resume_missed"));
});

test("after the bridge restarts mid-answer, the voice goes on from what had played", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const before = harness();
	await before.engine.start();
	before.engine.arm({ requester: null, speakerKey: "p1", endOfTurn: true });
	before
		.socket()
		.server({ type: "response.created", response: { id: "resp_1" } });
	// 400 ms of audio, of which 200 ms had played at the last sentence end.
	before.socket().server(audioDelta("resp_1", 9_600));
	before.socket().server(audioDelta("resp_1", 9_600));
	before.socket().server(transcriptDelta("resp_1", "F-12 is in review. "));
	before.advance(200);
	before.socket().server(transcriptDelta("resp_1", "It ships on Friday."));
	const saved = before.contexts.at(-1) as {
		cut?: { cause: string; heardChars: number; lostMs: number };
	};
	assert.equal(saved.cut?.cause, "restart");
	assert.equal(saved.cut?.heardChars, "F-12 is in review.".length);
	assert.equal(saved.cut?.lostMs, 200);

	const after = harness();
	after.engine.restore(saved);
	await after.engine.start();

	const resume = systemTexts(after.socket()).at(-1) ?? "";
	assert.match(resume, /<heard>\nF-12 is in review\.\n<\/heard>/);
	assert.doesNotMatch(resume, /Friday/);
	assert.equal(lastResponseKind(after.socket()), "resume");
	const seen = after.logs.find((entry) => entry.event === "speech.resumed");
	assert.equal(seen?.meta.cause, "restart");
});

test("a session near its end is replaced at once, and the answer it cut short goes on in the new one", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const h = harness();
	await h.engine.start();
	h.engine.arm({ requester: null, speakerKey: "p1", endOfTurn: true });
	h.socket().server({ type: "response.created", response: { id: "resp_1" } });
	h.socket().server(transcriptDelta("resp_1", "F-12 is in review. "));
	h.socket().server(audioDelta("resp_1", 9_600));
	assert.equal(h.engine.isPlaying(), true);

	// Ten and then two minutes before the hour, the answer holds the session.
	await pass(t, h, 50 * 60_000);
	await pass(t, h, 8 * 60_000);
	assert.equal(h.sockets.length, 1);
	void h.engine.respondToChat("Sam", "Is F-12 done?", "p2");
	// Thirty seconds before it, the session is replaced regardless.
	await pass(t, h, 90_000);

	assert.equal(h.sockets.length, 2);
	assert.equal(h.sockets[0].closed, true);
	assert.equal(h.engine.isPlaying(), false, "nothing waits for the old one");
	assert.equal(lastResponseKind(h.socket()), "resume");
	assert.match(
		systemTexts(h.socket()).at(-1) ?? "",
		/<heard>\nF-12 is in review\.\n<\/heard>/,
	);
	h.socket().server({ type: "response.created", response: { id: "resp_2" } });
	h.socket().server(done("resp_2"));
	assert.equal(lastResponseKind(h.socket()), "chat");
	assert.match(JSON.stringify(h.socket().sent), /Is F-12 done\?/);
});

test("from two minutes before its end a session starts nothing new, and is replaced once its answer is done", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const h = harness();
	await h.engine.start();
	h.engine.arm({ requester: null, speakerKey: "p1", endOfTurn: true });
	h.socket().server({ type: "response.created", response: { id: "resp_1" } });
	await pass(t, h, 50 * 60_000);
	await pass(t, h, 8 * 60_000);
	void h.engine.respondToChat("Sam", "Is F-12 done?", "p2");
	assert.equal(h.sockets.length, 1, "the answer in progress runs on");

	h.sockets[0].server(done("resp_1"));
	await flush();
	await flush();

	assert.equal(h.sockets.length, 2);
	assert.equal(
		lastResponseKind(h.sockets[0]),
		"wake",
		"the old session is asked for nothing more",
	);
	assert.equal(lastResponseKind(h.socket()), "chat");
	assert.ok(
		h.logs.some(
			(entry) =>
				entry.event === "realtime.reconnect" &&
				entry.meta.reason === "session_limit",
		),
	);
});

test("a session that says when it ends is replaced at the first quiet moment from ten minutes before then", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const h = harness();
	await h.engine.start();
	// The harness clock starts at 1 s: this session ends 20 minutes later.
	h.socket().server({
		type: "session.created",
		session: { expires_at: 1_201 },
	});
	await pass(t, h, 10 * 60_000 - 1);
	assert.equal(h.sockets.length, 1);
	await pass(t, h, 1);
	assert.equal(h.sockets.length, 2);
});

test("after its session drops, Parlume plays on until the outlet has played what it holds", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	let drain = () => {};
	const h = harness({
		drained: () =>
			new Promise<void>((resolve) => {
				drain = resolve;
			}),
	});
	await h.engine.start();
	h.engine.arm({ requester: null, speakerKey: "p1", endOfTurn: true });
	h.socket().server({ type: "response.created", response: { id: "resp_1" } });
	h.socket().server(audioDelta("resp_1", 9_600));

	h.socket().drop();
	await flush();
	assert.equal(h.outlet.ended, 1);
	assert.equal(h.engine.isPlaying(), true);
	drain();
	await flush();
	assert.equal(h.engine.isPlaying(), false);
});

test("audio with no outlet to play on is logged once per response", async () => {
	const h = harness();
	await h.engine.start();
	h.dropOutlet();
	h.engine.arm({ requester: null, speakerKey: "p1", endOfTurn: true });
	h.socket().server({ type: "response.created", response: { id: "resp_1" } });
	h.socket().server(audioDelta("resp_1", 4_800));
	h.socket().server(audioDelta("resp_1", 4_800));

	assert.deepEqual(
		h.logs
			.filter((entry) => entry.event === "realtime.audio_dropped")
			.map((entry) => entry.meta),
		[{ kind: "wake", reason: "no_outlet", bytes: 4_800 }],
	);
});

test("a response OpenAI's turn detection cancelled is logged as a misconfigured session", async () => {
	const h = harness();
	await h.engine.start();
	h.engine.arm({ requester: null, speakerKey: "p1", endOfTurn: true });
	h.socket().server({ type: "response.created", response: { id: "resp_1" } });
	h.socket().server(
		done("resp_1", [], "cancelled", {
			type: "cancelled",
			reason: "turn_detected",
		}),
	);

	assert.ok(
		h.logs.some(
			(entry) =>
				entry.event === "realtime.misconfigured" &&
				entry.meta.reason === "turn_detected",
		),
	);
});

const CLOSING_LINE =
	"This meeting is close to its time limit, so I answer only in the chat now. Please type your request here.";

test("in the last two minutes a chat read the voice made is not answered aloud: the asker is told to type the request", async () => {
	let closing = false;
	const h = harness({ closing: () => closing });
	await h.engine.start();
	h.engine.arm({
		requester: "Sam",
		speakerKey: "p1",
		request: "What did the chat say?",
		endOfTurn: true,
	});
	h.socket().server({ type: "response.created", response: { id: "resp_1" } });
	h.socket().clear();
	closing = true;
	h.socket().server(
		done("resp_1", [
			{
				type: "function_call",
				call_id: "call_1",
				name: "read_chat",
				arguments: "{}",
			},
		]),
	);
	await flush();

	assert.equal(h.socket().types().includes("response.create"), false);
	assert.deepEqual(h.posted, [CLOSING_LINE]);
});

test("in the last two minutes a held request is asked of Fabric, and an asker whose words the voice never heard is asked to type them", async () => {
	let closing = false;
	const h = harness({ closing: () => closing });
	await h.engine.start();
	h.engine.arm({
		requester: "Dev One",
		speakerKey: "p1",
		request: "Status of F-12?",
		endOfTurn: true,
	});
	h.socket().server({ type: "response.created", response: { id: "resp_1" } });
	h.socket().server(audioDelta("resp_1", 9_600));
	h.engine.arm({
		requester: "Dev Two",
		speakerKey: "p2",
		request: "Status of F-13?",
		endOfTurn: true,
	});
	h.engine.arm({
		requester: "Dev Three",
		speakerKey: "p3",
		request: "",
		endOfTurn: true,
	});
	h.socket().clear();
	closing = true;
	h.engine.closeForCap();
	await flush();

	assert.equal(h.socket().types().includes("response.create"), false);
	assert.deepEqual(
		h.jobs.map((job) => job.request),
		["Status of F-13?"],
	);
	assert.deepEqual(h.posted, [CLOSING_LINE]);
	assert.deepEqual(
		h.logs
			.filter((entry) => entry.event === "realtime.request_to_chat")
			.map((entry) => entry.meta.busy),
		[false, false],
		"an unheard request is not logged as busy while a job runs",
	);
});

test("in the last two minutes a held request that comes while Fabric is busy asks its asker to type it instead of starting a second job", async () => {
	let closing = false;
	const h = harness({ closing: () => closing });
	await h.engine.start();
	h.engine.arm({
		requester: "Dev One",
		speakerKey: "p1",
		request: "Status of F-12?",
		endOfTurn: true,
	});
	h.socket().server({ type: "response.created", response: { id: "resp_1" } });
	h.socket().server(audioDelta("resp_1", 9_600));
	h.engine.arm({
		requester: "Dev Two",
		speakerKey: "p2",
		request: "Status of F-13?",
		endOfTurn: true,
	});
	h.engine.arm({
		requester: "Dev Three",
		speakerKey: "p3",
		request: "Status of F-14?",
		endOfTurn: true,
	});
	h.socket().clear();
	closing = true;
	h.engine.closeForCap();
	await flush();

	assert.deepEqual(
		h.jobs.map((job) => job.request),
		["Status of F-13?"],
	);
	assert.deepEqual(h.posted, [CLOSING_LINE]);
	assert.deepEqual(
		h.logs
			.filter((entry) => entry.event === "realtime.request_to_chat")
			.map((entry) => entry.meta.busy),
		[false, true],
	);
});

test("in the last two minutes each asker is asked to type their request once", async () => {
	const h = harness({ closing: () => true });
	await h.engine.start();
	for (const speakerKey of ["p1", "p1", "p2"]) {
		// A new utterance: the asker spoke again after the last request.
		h.socket().server({ type: "input_audio_buffer.speech_started" });
		h.engine.arm({
			requester: null,
			speakerKey,
			request: "",
			endOfTurn: true,
		});
	}
	await flush();

	const moved = h.logs.filter(
		(entry) => entry.event === "realtime.request_to_chat",
	);
	assert.equal(moved.length, 3, "all three requests reach the chat route");
	assert.deepEqual(h.posted, [CLOSING_LINE, CLOSING_LINE]);
});

test("in the last two minutes an answer waiting for its resume goes to the chat at once and is not counted as a failed resume", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	let closing = false;
	const first = new FakeSocket();
	let opens = 0;
	const h = harness({
		closing: () => closing,
		connect: () =>
			opens++ === 0
				? Promise.resolve(first)
				: new Promise<FakeSocket>(() => {}),
	});
	await h.engine.start();
	h.engine.arm({
		requester: null,
		speakerKey: "p1",
		request: "Status of F-12?",
		endOfTurn: true,
	});
	first.server({ type: "response.created", response: { id: "resp_1" } });
	first.server(
		done("resp_1", [
			{
				type: "function_call",
				call_id: "call_1",
				name: "ask_fabric",
				arguments: JSON.stringify({ request: "Status of F-12?" }),
			},
		]),
	);
	await flush();
	first.server({ type: "response.created", response: { id: "resp_2" } });
	first.server(done("resp_2"));
	h.engine.deliverResult({
		job: "J1",
		status: "completed",
		text: "F-12 is in review. It ships on Friday.",
		chatTags: [],
		turnId: "turn-1",
	});
	first.server({ type: "response.created", response: { id: "resp_3" } });
	first.server(transcriptDelta("resp_3", "F-12 is in review. "));
	first.server(audioDelta("resp_3", 9_600));
	first.drop();
	await pass(t, h, 1_000);

	closing = true;
	h.engine.closeForCap();
	await flush();
	assert.deepEqual(
		h.posted.filter((text) => text.includes("Friday")),
		["F-12 is in review. It ships on Friday."],
	);
	assert.ok(
		h.logs.some((entry) => entry.event === "realtime.resume_to_chat"),
	);

	await pass(t, h, 15_000);
	assert.equal(
		h.logs.some((entry) => entry.event === "realtime.resume_missed"),
		false,
	);
	assert.equal(h.posted.filter((text) => text.includes("Friday")).length, 1);
});
