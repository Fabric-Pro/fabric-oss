import assert from "node:assert/strict";
import test from "node:test";
import { loadParlumeModule } from "./parlume-test-runtime.mts";
import type { ParlumeTranscript } from "./parlume-transcriber.ts";

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
const caller = { id: "participant-1", name: "Caller" };
const streamState = { sessionId: "session-1", botId: "bot-1" };
const instruction = "Hey Fabric. Write in the chat.";
const payload = "Meeting notes will be shared tomorrow.";

interface Bridge {
	audio: Map<object, { startTime: number }>;
	speakers: { attribute(): typeof caller | null };
	handleTranscript(
		conn: object,
		state: typeof streamState,
		transcript: ParlumeTranscript,
	): Promise<void>;
	floor: { interrupt(state: typeof streamState): Promise<void> };
}

async function meeting() {
	const requests: { path: string; body: Record<string, unknown> }[] = [];
	const data = new Map<string, unknown>();
	const { Parlume } = loadParlumeModule("./parlume.ts", async (url, init) => {
		requests.push({
			path: new URL(String(url)).pathname,
			body: JSON.parse(String((init as RequestInit).body)),
		});
		return Response.json({ accepted: true });
	}) as { Parlume: new (ctx: unknown, env: unknown) => Bridge };
	const bridge = new Parlume(
		{
			storage: {
				get: async (key: string) => data.get(key),
				put: async (
					key: string | Record<string, unknown>,
					value?: unknown,
				) => {
					if (typeof key === "string") {
						data.set(key, value);
					} else {
						for (const [name, entry] of Object.entries(key)) {
							data.set(name, entry);
						}
					}
				},
				delete: async (key: string) => data.delete(key),
				setAlarm: async () => {},
			},
		},
		{
			FABRIC_API_URL: "https://fabric.example",
			AGENT_SERVICE_SECRET: "fixture",
		},
	);
	const conn = {};
	bridge.audio.set(conn, { startTime: 1_000_000 });
	let speaker: typeof caller | null = caller;
	bridge.speakers = { attribute: () => speaker };
	let receive = (_event: { data: string }) => {};
	const socket = {
		accept() {},
		send() {},
		close() {},
		addEventListener(type: string, listener: typeof receive) {
			if (type === "message") {
				receive = listener;
			}
		},
	};
	const handlers: Promise<void>[] = [];
	const { ParlumeTranscriber } = loadParlumeModule(
		"./parlume-transcriber.ts",
		async () => Response.json({}),
	) as {
		ParlumeTranscriber: new (
			options: unknown,
		) => {
			send(chunk: ArrayBuffer, epochMs: number): void;
			close(): void;
		};
	};
	const transcriber = new ParlumeTranscriber({
		sampleRate: 16_000,
		connect: async () => socket,
		onTranscript: (transcript: ParlumeTranscript) =>
			handlers.push(
				bridge.handleTranscript(conn, streamState, transcript),
			),
		onStatus() {},
	});
	transcriber.send(new ArrayBuffer(2_560), 1_000_000);
	await flush();
	return {
		bridge,
		requests,
		close: () => transcriber.close(),
		turns: () =>
			requests.filter((request) => request.path.endsWith("/turns")),
		async event(
			event: string,
			text: string,
			turnIndex = 0,
			attributed: typeof caller | null = caller,
		) {
			speaker = attributed;
			receive({
				data: JSON.stringify({
					event,
					turn_index: turnIndex,
					transcript: text,
					audio_window_start: turnIndex * 2,
					audio_window_end: turnIndex * 2 + 1.5,
				}),
			});
			await Promise.all(handlers);
		},
	};
}

test("split dictation survives partials at 100/350 ms and a final at 1950 ms", async (t) => {
	t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
	const live = await meeting();
	t.after(live.close);
	await live.event("EndOfTurn", instruction);
	t.mock.timers.tick(100);
	await flush();
	assert.equal(live.turns().length, 0);
	await live.event("StartOfTurn", "Meeting", 1);
	t.mock.timers.tick(250);
	await live.event("Update", "Meeting notes will be shared", 1);
	t.mock.timers.tick(1_600);
	await live.event("EndOfTurn", payload, 1);
	t.mock.timers.tick(2_499);
	await flush();
	assert.equal(live.turns().length, 0);
	t.mock.timers.tick(1);
	await flush();
	assert.deepEqual(
		live.turns().map(({ body }) => body.text),
		[`Write in the chat. ${payload}`],
	);
	assert.equal(live.turns()[0]?.body.speakerId, caller.id);
	assert.equal(
		live.requests.filter((r) => r.path.endsWith("/segments")).length,
		2,
	);
	t.mock.timers.tick(10_000);
	await flush();
	assert.equal(live.turns().length, 1);
});

test("dictation keeps all three finals until the speaker is quiet", async (t) => {
	t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
	const live = await meeting();
	t.after(live.close);
	await live.event("EndOfTurn", instruction);
	t.mock.timers.tick(1_950);
	await live.event("EndOfTurn", "Meeting notes", 1);
	t.mock.timers.tick(1_000);
	await flush();
	assert.equal(live.turns().length, 0);
	await live.event("EndOfTurn", "will be shared tomorrow.", 2);
	t.mock.timers.tick(2_499);
	await flush();
	assert.equal(live.turns().length, 0);
	t.mock.timers.tick(1);
	await flush();
	assert.deepEqual(
		live.turns().map(({ body }) => body.text),
		[`Write in the chat. ${payload}`],
	);
	t.mock.timers.tick(10_000);
	await flush();
	assert.equal(live.turns().length, 1);
});

test("missing dictation times out once with the original incomplete request", async (t) => {
	t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
	const live = await meeting();
	t.after(live.close);
	await live.event("EndOfTurn", instruction);
	t.mock.timers.tick(2_499);
	await flush();
	assert.equal(live.turns().length, 0);
	t.mock.timers.tick(1);
	await flush();
	assert.deepEqual(
		live.turns().map(({ body }) => body.text),
		["Write in the chat."],
	);
	await live.event("EndOfTurn", payload, 1);
	t.mock.timers.tick(10_000);
	await flush();
	assert.equal(
		live.turns().length,
		1,
		"a late final cannot replay a dispatched turn",
	);
});

for (const [label, initial, continuation] of [
	["different speaker", caller, { id: "participant-2", name: "Other" }],
	["unknown continuation", caller, null],
	["unknown caller", null, caller],
	["two unknown turns", null, null],
] as const) {
	test(`dictation rejects ${label}`, async (t) => {
		t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
		const live = await meeting();
		t.after(live.close);
		await live.event("EndOfTurn", instruction, 0, initial);
		t.mock.timers.tick(100);
		await flush();
		assert.equal(live.turns().length, 0);
		await live.event("EndOfTurn", payload, 1, continuation);
		t.mock.timers.tick(2_400);
		await flush();
		assert.deepEqual(
			live.turns().map(({ body }) => body.text),
			["Write in the chat."],
		);
	});
}

test("cancellation discards incomplete dictation", async (t) => {
	t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
	const live = await meeting();
	t.after(live.close);
	await live.event("EndOfTurn", instruction);
	await live.bridge.floor.interrupt(streamState);
	t.mock.timers.tick(10_000);
	await flush();
	assert.equal(live.turns().length, 0);
});

for (const request of [
	"Hey Fabric. What is the status?",
	`Hey Fabric. Write in the chat: ${payload}`,
	"Hey Fabric. Post that summary in the chat.",
]) {
	test(`complete request dispatches on the first timer tick: ${request}`, async (t) => {
		t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
		const live = await meeting();
		t.after(live.close);
		await live.event("EndOfTurn", request);
		t.mock.timers.tick(1);
		await flush();
		assert.equal(live.turns().length, 1);
	});
}

test("a fresh wake replaces incomplete dictation from the same speaker", async (t) => {
	t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
	const live = await meeting();
	t.after(live.close);
	await live.event("EndOfTurn", instruction);
	t.mock.timers.tick(100);
	await live.event("EndOfTurn", "Hey Fabric. What is the status?", 1);
	t.mock.timers.tick(1);
	await flush();
	assert.deepEqual(
		live.turns().map(({ body }) => body.text),
		["What is the status?"],
	);
	t.mock.timers.tick(10_000);
	await flush();
	assert.equal(live.turns().length, 1);
});

test("a bare fresh wake discards incomplete dictation and arms a new request", async (t) => {
	t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
	const live = await meeting();
	t.after(live.close);
	await live.event("EndOfTurn", instruction);
	t.mock.timers.tick(100);
	await live.event("EndOfTurn", "Hey Fabric.", 1);
	t.mock.timers.tick(3_000);
	await flush();
	assert.equal(live.turns().length, 0);
	await live.event("EndOfTurn", "What is the status?", 2);
	t.mock.timers.tick(300);
	await flush();
	assert.deepEqual(
		live.turns().map(({ body }) => body.text),
		["What is the status?"],
	);
});

test("dictation partials cannot extend the draft past eight seconds", async (t) => {
	t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
	const live = await meeting();
	t.after(live.close);
	await live.event("EndOfTurn", instruction);
	for (let elapsed = 0; elapsed < 7_000; elapsed += 1_000) {
		t.mock.timers.tick(1_000);
		await live.event("Update", "Meeting notes", 1);
	}
	t.mock.timers.tick(999);
	await flush();
	assert.equal(live.turns().length, 0);
	t.mock.timers.tick(1);
	await flush();
	assert.deepEqual(
		live.turns().map(({ body }) => body.text),
		["Write in the chat."],
	);
});

test("dictation finals retain the original eight-second deadline", async (t) => {
	t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
	const live = await meeting();
	t.after(live.close);
	await live.event("EndOfTurn", instruction);
	for (let index = 1; index <= 3; index++) {
		t.mock.timers.tick(2_000);
		await live.event("EndOfTurn", "Meeting notes", index);
		await flush();
		assert.equal(live.turns().length, 0);
	}
	t.mock.timers.tick(1_999);
	await flush();
	assert.equal(live.turns().length, 0);
	t.mock.timers.tick(1);
	await flush();
	assert.deepEqual(
		live.turns().map(({ body }) => body.text),
		["Write in the chat. Meeting notes Meeting notes Meeting notes"],
	);
});
