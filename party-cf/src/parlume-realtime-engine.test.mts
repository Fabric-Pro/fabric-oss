import assert from "node:assert/strict";
import { test } from "node:test";
import { loadParlumeModule } from "./parlume-test-runtime.mts";

type Engine = {
	active: boolean;
	start(): Promise<{ ok: boolean; reason?: string }>;
	stop(reason: string): void;
	arm(input: {
		requester: string | null;
		speakerKey: string;
		endOfTurn: boolean;
	}): void;
	noteLine(speaker: string | null, text: string): void;
	say(text: string): Promise<boolean>;
	deliverResult(input: {
		job: string;
		status: "completed" | "failed";
		text: string;
		chatTags: string[];
	}): boolean;
	isPlaying(): boolean;
	isResponding(): boolean;
	hasJob(generation: number): boolean;
	silence(kind: "mute" | "cancel", droppedBytes: number): void;
};

function loadEngine() {
	return loadParlumeModule("./parlume-realtime-engine.ts", async () =>
		Response.json({}),
	) as {
		ParlumeRealtimeEngine: new (host: unknown) => Engine;
		parseParlumeFabricResult(body: unknown): unknown;
	};
}

const flush = () => new Promise((resolve) => setImmediate(resolve));
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
	} = {},
) {
	const sockets: FakeSocket[] = [];
	const enqueued: number[] = [];
	const jobs: Array<Record<string, unknown>> = [];
	const usage: unknown[] = [];
	const fallbacks: string[] = [];
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
		drained: () => new Promise<void>(() => {}),
	};
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
		outlet: () => outlet,
		generation: () => 7,
		dispatchJob: async (job: Record<string, unknown>) => {
			jobs.push(job);
			return options.accept ?? true;
		},
		postChat: async () => ({ posted: true, tag: "P3" }),
		readChat: () => [{ from: "Sam", text: "Link?" }],
		reportUsage: (entry: unknown) => usage.push(entry),
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
		fallbacks,
		logs,
		outlet,
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
) {
	return {
		type: "response.done",
		response: {
			id: responseId,
			status,
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
});

test("Parlume's voice plays through the outlet, and a barge-in cancels and truncates to what was heard", async () => {
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
	h.engine.silence("mute", 4_800);
	assert.equal(h.engine.isPlaying(), false);
	assert.deepEqual(h.socket().sent, [
		{ type: "response.cancel", response_id: "resp_1" },
		{
			type: "conversation.item.truncate",
			item_id: "item_resp_1",
			content_index: 0,
			audio_end_ms: 300,
		},
	]);
	// Audio still arriving for the cancelled response is not played.
	h.socket().server(audioDelta("resp_1", 4_800));
	assert.equal(h.enqueued.length, 2);
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
	h.engine.silence("cancel", 0);
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
				arguments: JSON.stringify({ text: "https://example.com/F-12" }),
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
		{ posted: true, tag: "P3" },
		{ messages: [{ from: "Sam", text: "Link?" }] },
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

test("the worker's result body is validated", () => {
	const { parseParlumeFabricResult } = loadEngine();
	assert.deepEqual(
		plain(
			parseParlumeFabricResult({
				job: "J4",
				status: "completed",
				text: "Done.",
				chatTags: ["P2", "bogus"],
			}),
		),
		{ job: "J4", status: "completed", text: "Done.", chatTags: ["P2"] },
	);
	for (const body of [
		{ job: "4", status: "completed", text: "x" },
		{ job: "J4", status: "running", text: "x" },
		{ job: "J4", status: "completed", text: " " },
		null,
	]) {
		assert.equal(parseParlumeFabricResult(body), null);
	}
});
