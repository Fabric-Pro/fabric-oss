import assert from "node:assert/strict";
import test from "node:test";
import {
	connectedMeeting,
	control,
	flush,
	plain,
	say,
	sleep,
	slowAura,
} from "./parlume-meeting-harness.mts";
import { readReplayFixture, replayMeeting } from "./parlume-replay.mts";
import { loadParlumeModule } from "./parlume-test-runtime.mts";

// Requests to Parlume in a meeting where more than one participant talks:
// who asked is recognised (a request reaches Fabric for its asker) apart from
// what is played (the answer reaches the bot whole), in both voices.

const ana = { name: "Ana Example", id: "participant-1" };
const bo = { name: "Bo Example", id: "participant-2" };
const LINK = "https://git.example.com/example-org/coding-instructions";

type Speaker = { name: string; id: string };

/** Speaker updates, as `[speaker, from s, to s]` on the meeting's audio clock. */
function speaking(spans: Array<[Speaker, number, number | null]>) {
	return control("speakers", {
		updates: spans.flatMap(([speaker, from, to]) => [
			{
				name: speaker.name,
				id: speaker.id,
				timestamp: 1_000_000 + from * 1000,
				isSpeaking: true,
			},
			...(to === null
				? []
				: [
						{
							name: speaker.name,
							id: speaker.id,
							timestamp: 1_000_000 + to * 1000,
							isSpeaking: false,
						},
					]),
		]),
	});
}

function parlumePost(id: string, text: string) {
	return control("chat-message", {
		id,
		text,
		senderName: "Fabric Parlume",
		senderId: "parlume-bot",
		toBot: false,
		timestampMs: 1_000_000,
	});
}

async function waitFor(condition: () => boolean, ms = 3_000) {
	for (let waited = 0; waited < ms && !condition(); waited += 20) {
		await sleep(20);
	}
	assert.ok(condition(), "timed out");
}

// The classic voice: Flux hears the meeting, Fabric answers with `say`.

type Classic = Awaited<ReturnType<typeof connectedMeeting>>;

const turns = (harness: Classic) =>
	harness.requests.filter((r) => r.path.endsWith("/turns"));
const interrupts = (harness: Classic) =>
	harness.requests.filter((r) => r.path.endsWith("/interrupt"));
const segments = (harness: Classic) =>
	harness.requests.filter((r) => r.path.endsWith("/segments"));
const chatPosts = (harness: Classic) =>
	harness.requests.filter((r) => r.path.endsWith("/chat"));
const deliveries = (harness: Classic) =>
	harness.requests.filter((r) => r.path.endsWith("/chat-delivery"));
const spoken = (harness: Classic) =>
	harness.auraCalls.map((call) => (call.inputs as { text: string }).text);

function heard(
	harness: Classic,
	event: "Update" | "EndOfTurn" | "EagerEndOfTurn" | "TurnResumed",
	turnIndex: number,
	window: [number, number],
	transcript: string,
) {
	harness.flux.turn({
		event,
		turn_index: turnIndex,
		audio_window_start: window[0],
		audio_window_end: window[1],
		transcript,
	});
}

async function generationState(harness: Classic, voiceGeneration: number) {
	return plain(
		await (
			await harness.bridge.onRequest(
				control("verify-generation", { voiceGeneration }),
			)
		).json(),
	);
}

/** Ana asks in the first two seconds; Bo talks from the second to the fifth. */
async function anaAsks(question: string) {
	const harness = await connectedMeeting({ aura: slowAura });
	await harness.bridge.onRequest(
		speaking([
			[ana, 0, 2],
			[bo, 2, 4.5],
		]),
	);
	heard(harness, "EndOfTurn", 0, [0.1, 1.5], `Hey Fabric, ${question}`);
	await waitFor(() => turns(harness).length === 1);
	const turn = turns(harness)[0];
	assert.equal(turn?.body.speakerId, ana.id);
	assert.equal(turn?.body.text, question);
	return { harness, generation: Number(turn?.body.voiceGeneration) };
}

// Recorded from real Flux: QA Example asks over the end of Dev Example's
// sentence, and Flux hears both as one turn.
test("a question asked over another participant's sentence is heard once for its asker, and its answer plays whole without being asked again", async () => {
	const recorded = readReplayFixture(
		new URL("./fixtures/parlume-replay/two-speakers.json", import.meta.url),
	);
	const scorecard = await replayMeeting(
		{
			...recorded,
			parlume: [
				{
					at: 9.5,
					sentences: [
						"F-12 is in review.",
						"It waits for one approval.",
					],
					seconds: 4,
				},
			],
		},
		{ speed: 4 },
	);

	assert.equal(
		scorecard.wakes,
		1,
		"recognised once: nobody had to repeat it",
	);
	assert.equal(scorecard.questions[0]?.speaker, "QA Example");
	assert.equal(scorecard.questions[0]?.heardRight, true);
	assert.deepEqual(scorecard.falseWakes, []);
	assert.deepEqual(scorecard.missed, []);
	assert.deepEqual(scorecard.replies, [{ played: true, interrupted: false }]);
	assert.equal(scorecard.interrupts, 0);
});

test("another participant talking while a request is with Fabric leaves it current, and its answer then plays whole", async () => {
	const { harness, generation } = await anaAsks(
		"what coding instructions are connected to this project?",
	);

	heard(harness, "Update", 1, [2.2, 2.8], "I think we should");
	await flush();
	heard(
		harness,
		"EndOfTurn",
		1,
		[2.2, 4.2],
		"I think we should merge the export fix first.",
	);
	await waitFor(() =>
		segments(harness).some((r) => r.body.speakerId === bo.id),
	);

	assert.equal(
		segments(harness).find((r) => r.body.speakerId === bo.id)?.body.text,
		"I think we should merge the export fix first.",
		"Bo's words are heard as the meeting's, not as a request",
	);
	assert.equal(turns(harness).length, 1, "the request is not asked again");
	assert.deepEqual(interrupts(harness), [], "the request is not dropped");
	assert.equal((await generationState(harness, generation)).current, true);

	const keepAlive = setInterval(() => {}, 1_000);
	const result = plain(
		await (
			await harness.bridge.onRequest(
				say(
					[
						"This project uses the coding instructions repository.",
						"It holds the review checklist.",
					],
					{},
					String(generation),
				),
			)
		).json(),
	);
	clearInterval(keepAlive);

	assert.equal(result.played, true);
	assert.equal(result.interrupted, false);
	assert.equal(result.heard, 2);
	assert.deepEqual(interrupts(harness), []);
	await harness.bridge.onClose(harness.bot, 1000, "done");
});

test("a second participant's request made while the first is with Fabric waits, and both are answered in order, each for its asker", async () => {
	const { harness, generation } = await anaAsks(
		"what is left for the release?",
	);
	const keepAlive = setInterval(() => {}, 1_000);

	heard(
		harness,
		"EndOfTurn",
		1,
		[2.2, 4.2],
		"Hey Fabric, who reviews the migration?",
	);
	await sleep(300);
	assert.equal(turns(harness).length, 1, "Bo's request waits");
	assert.deepEqual(interrupts(harness), []);
	assert.equal((await generationState(harness, generation)).current, true);

	const first = plain(
		await (
			await harness.bridge.onRequest(
				say(["Two features are left."], {}, String(generation)),
			)
		).json(),
	);
	assert.equal(first.played, true);
	await waitFor(() => turns(harness).length === 2);
	const second = turns(harness)[1];
	assert.equal(second?.body.speakerId, bo.id);
	assert.equal(second?.body.text, "who reviews the migration?");
	assert.equal(second?.body.voiceGeneration, generation + 1);

	const answer = plain(
		await (
			await harness.bridge.onRequest(
				say(
					["The data team reviews it."],
					{},
					String(second?.body.voiceGeneration),
				),
			)
		).json(),
	);
	clearInterval(keepAlive);

	assert.equal(answer.played, true);
	assert.equal(answer.interrupted, false);
	assert.deepEqual(spoken(harness), [
		"Two features are left.",
		"Bo, The data team reviews it.",
	]);
	assert.deepEqual(interrupts(harness), []);
	await harness.bridge.onClose(harness.bot, 1000, "done");
});

test("a request that waited for an answer starts when the participant still talking after it pauses, not over them", async () => {
	const { harness, generation } = await anaAsks(
		"what is left for the release?",
	);
	const keepAlive = setInterval(() => {}, 1_000);
	const playing = harness.bridge.onRequest(
		say(
			["Two features are left.", "Both wait for review."],
			{},
			String(generation),
		),
	);
	await sleep(250);
	heard(
		harness,
		"EndOfTurn",
		1,
		[2.2, 4.2],
		"Hey Fabric, who reviews the migration?",
	);
	await sleep(300);
	heard(harness, "Update", 2, [5, 5.6], "and on the release I think");
	await flush();

	assert.equal(plain(await (await playing).json()).played, true);
	assert.ok(
		harness.logs.some((entry) => entry.message === "[Parlume] queue.added"),
		"Bo's request waits in the queue",
	);
	await sleep(500);
	assert.equal(
		turns(harness).length,
		1,
		"Bo's request waits for Ana's pause",
	);

	heard(
		harness,
		"EndOfTurn",
		2,
		[5, 6.5],
		"and on the release I think we are fine.",
	);
	const pausedAt = performance.now();
	await waitFor(() => turns(harness).length === 2);
	clearInterval(keepAlive);

	const second = turns(harness)[1];
	assert.equal(second?.body.speakerId, bo.id);
	assert.equal(second?.body.text, "who reviews the migration?");
	assert.ok((second?.at ?? 0) >= pausedAt, "asked once Ana paused");
	assert.deepEqual(interrupts(harness), []);
	await harness.bridge.onClose(harness.bot, 1000, "done");
});

test("a request whose early end of turn Flux takes back as another participant starts talking is asked again for its asker, and answered", async () => {
	const harness = await connectedMeeting({ aura: slowAura });
	await harness.bridge.onRequest(
		speaking([
			[ana, 0, 1.8],
			[bo, 1.8, 2.9],
		]),
	);
	heard(
		harness,
		"EagerEndOfTurn",
		0,
		[0.1, 1.7],
		"Hey Fabric, what is the plan?",
	);
	await waitFor(() => turns(harness).length === 1);
	heard(harness, "TurnResumed", 0, [0.1, 1.9], "");
	await waitFor(() => interrupts(harness).length === 1);

	heard(
		harness,
		"EndOfTurn",
		0,
		[0.1, 2.9],
		"Hey Fabric, what is the plan? I think we ship it Friday.",
	);
	await waitFor(() => turns(harness).length === 2);
	const asked = turns(harness)[1];
	assert.equal(asked?.body.speakerId, ana.id);
	assert.match(String(asked?.body.text), /^what is the plan\?/);
	assert.ok(
		Number(asked?.body.voiceGeneration) >
			Number(turns(harness)[0]?.body.voiceGeneration),
	);

	const keepAlive = setInterval(() => {}, 1_000);
	const result = plain(
		await (
			await harness.bridge.onRequest(
				say(
					["The plan is ready."],
					{},
					String(asked?.body.voiceGeneration),
				),
			)
		).json(),
	);
	clearInterval(keepAlive);

	assert.equal(result.played, true);
	assert.equal(result.interrupted, false);
	assert.equal(
		interrupts(harness).length,
		1,
		"only the early guess was stopped",
	);
	await harness.bridge.onClose(harness.bot, 1000, "done");
});

test("a spoken request for a link in a group meeting is asked for its asker, and the link goes to this meeting's bot and is confirmed for that turn", async () => {
	const harness = await connectedMeeting({ aura: slowAura });
	await harness.bridge.onRequest(
		speaking([
			[ana, 0, 2],
			[bo, 2, 5],
		]),
	);
	heard(
		harness,
		"EndOfTurn",
		0,
		[0.1, 1.9],
		"The coding instructions moved last week.",
	);
	heard(
		harness,
		"EndOfTurn",
		1,
		[2.1, 4.9],
		"Hey Fabric, can you give the direct link to coding instructions in the chat, please?",
	);
	await waitFor(() => turns(harness).length === 1);
	const turn = turns(harness)[0];
	assert.equal(turn?.body.speakerId, bo.id);
	assert.equal(turn?.body.replyChannel, "VOICE");
	assert.match(
		String(turn?.body.text),
		/direct link to coding instructions in the chat/,
	);

	const sent = plain(
		await (
			await harness.bridge.onRequest(
				control("chat", {
					message: `Coding instructions: ${LINK}`,
					turnId: "turn-1",
					voiceGeneration: turn?.body.voiceGeneration,
				}),
			)
		).json(),
	);
	assert.deepEqual(sent, { sent: true, tag: "P1", delivery: "queued" });
	assert.deepEqual(
		chatPosts(harness).map((r) => r.body),
		[
			{
				sessionId: "session-1",
				botId: "bot_abc123",
				message: `[P1] Coding instructions: ${LINK}`,
				turnId: "turn-1",
			},
		],
	);

	await harness.bridge.onRequest(
		parlumePost("msg_1", `[P1] Coding instructions: ${LINK}`),
	);
	await waitFor(() => deliveries(harness).length === 1);
	assert.deepEqual(
		{
			turnId: deliveries(harness)[0]?.body.turnId,
			tag: deliveries(harness)[0]?.body.tag,
			outcome: deliveries(harness)[0]?.body.outcome,
		},
		{ turnId: "turn-1", tag: "P1", outcome: "confirmed" },
	);
	assert.equal(turns(harness).length, 1, "the echo is not a request");
	await harness.bridge.onClose(harness.bot, 1000, "done");
});

test("a link request lost under overlapping speech asks nothing; its clear repeat is asked once and its link is posted", async () => {
	const harness = await connectedMeeting({ aura: slowAura });
	await harness.bridge.onRequest(
		speaking([
			[ana, 0, 3],
			[bo, 1, 3.5],
			[ana, 5, 7],
		]),
	);
	heard(
		harness,
		"EndOfTurn",
		0,
		[0.1, 3.4],
		"so the export fix goes first thank you can you give the direct link to coding instructions in the chat please",
	);
	await sleep(700);
	assert.equal(turns(harness).length, 0, "not recognised: nothing is asked");
	assert.equal(chatPosts(harness).length, 0);

	heard(
		harness,
		"EndOfTurn",
		1,
		[5.1, 6.9],
		"Hey Fabric, could you please give me the direct link to the coding instructions in the chat?",
	);
	await waitFor(() => turns(harness).length === 1);
	const turn = turns(harness)[0];
	assert.equal(turn?.body.speakerId, ana.id);
	assert.equal(
		turn?.body.text,
		"could you please give me the direct link to the coding instructions in the chat?",
	);

	const sent = plain(
		await (
			await harness.bridge.onRequest(
				control("chat", {
					message: `Coding instructions: ${LINK}`,
					turnId: "turn-1",
					voiceGeneration: turn?.body.voiceGeneration,
				}),
			)
		).json(),
	);
	assert.equal(sent.sent, true);
	assert.equal(
		chatPosts(harness)[0]?.body.message,
		`[P1] Coding instructions: ${LINK}`,
	);
	await sleep(300);
	assert.equal(turns(harness).length, 1, "the repeat is asked once");
	await harness.bridge.onClose(harness.bot, 1000, "done");
});

test("a clear repeated link request whose post Fabric cannot deliver is reported to the worker as not sent, and is never offered as posted", async () => {
	const harness = await connectedMeeting({
		aura: slowAura,
		fabricDelay: (path) =>
			path.endsWith("/chat")
				? Promise.reject(new Error("chat down"))
				: Promise.resolve(),
	});
	await harness.bridge.onRequest(
		speaking([
			[ana, 0, 2],
			[bo, 2, 5],
		]),
	);
	heard(
		harness,
		"EndOfTurn",
		0,
		[2.1, 4.9],
		"Hey Fabric, could you please give me the direct link to the coding instructions in the chat?",
	);
	await waitFor(() => turns(harness).length === 1);
	const turn = turns(harness)[0];
	assert.equal(turn?.body.speakerId, bo.id);

	const sent = plain(
		await (
			await harness.bridge.onRequest(
				control("chat", {
					message: `Coding instructions: ${LINK}`,
					turnId: "turn-1",
					voiceGeneration: turn?.body.voiceGeneration,
				}),
			)
		).json(),
	);
	assert.deepEqual(sent, { sent: false, reason: "failed" });
	assert.equal(chatPosts(harness).length, 1, "Fabric was asked to post it");
	await sleep(100);
	assert.deepEqual(deliveries(harness), [], "no delivery is reported for it");

	const keepAlive = setInterval(() => {}, 1_000);
	const failure = plain(
		await (
			await harness.bridge.onRequest(
				say(
					["I could not post the link in the chat."],
					{},
					String(turn?.body.voiceGeneration),
				),
			)
		).json(),
	);
	clearInterval(keepAlive);
	assert.equal(failure.played, true, "the worker's failure line is heard");
	assert.deepEqual(spoken(harness), [
		"I could not post the link in the chat.",
	]);
	await harness.bridge.onClose(harness.bot, 1000, "done");
});

// The realtime voice: Flux says who addressed Parlume, and the OpenAI
// session answers; `ask_fabric` runs as a Fabric turn.

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
}

type RealtimeBridge = {
	onStart(): Promise<void>;
	onConnect(conn: unknown, ctx: { request: { url: string } }): Promise<void>;
	onMessage(conn: unknown, message: string): Promise<void>;
	onRequest(request: Request): Promise<Response>;
	onClose(conn: unknown): Promise<void>;
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

const settle = async () => {
	for (let index = 0; index < 10; index++) {
		await new Promise((resolve) => setImmediate(resolve));
	}
};

/** A meeting on the realtime voice; Fabric fails the paths in `failing`. */
async function realtimeMeeting(options: { failing?: string[] } = {}) {
	const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
	const flux = new FakeSocket();
	const openai = new FakeSocket();
	const fetch = async (url: unknown, init: unknown) => {
		const { body } = (init ?? {}) as { body?: string };
		const path = new URL(String(url)).pathname;
		requests.push({
			path,
			body: typeof body === "string" ? JSON.parse(body) : {},
		});
		if (path.endsWith("/v1/realtime")) {
			return { status: 101, webSocket: openai };
		}
		if (options.failing?.some((failing) => path.endsWith(failing))) {
			return Response.json({ error: "unavailable" }, { status: 502 });
		}
		if (path.endsWith("/verify-stream")) {
			return Response.json({
				valid: true,
				hardStopAt: new Date(Date.now() + 3_600_000).toISOString(),
				streamGeneration: 1,
			});
		}
		if (path.endsWith("/realtime-session")) {
			return Response.json({
				clientSecret: "ek_meeting",
				expiresAt: 1_900_000_000,
				model: "gpt-realtime-2.1",
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
	const { Parlume } = loadParlumeModule("./parlume.ts", fetch) as {
		Parlume: new (ctx: unknown, env: unknown) => RealtimeBridge;
	};
	const bridge = new Parlume(
		{ storage },
		{
			FABRIC_API_URL: "https://fabric.example",
			AGENT_SERVICE_SECRET: "service-secret",
			AI: {
				run: async (model: string) =>
					model === "@cf/deepgram/aura-2-en"
						? new Response(new Uint8Array(4_800))
						: { status: 101, webSocket: flux },
			},
		},
	);
	const sent: string[] = [];
	const bot = { send: (message: string) => sent.push(message), close() {} };
	// The realtime voice plays through the outlet, whose timers do not keep
	// the test process alive.
	const keepAlive = setInterval(() => {}, 1_000);
	const end = async () => {
		clearInterval(keepAlive);
		await bridge.onClose(bot);
	};
	await bridge.onStart();
	await bridge.onConnect(bot, { request: { url: STREAM_URL } });
	for (let end = 1_000_010; end <= 1_000_080; end += 10) {
		await bridge.onMessage(bot, audio(end));
	}
	await settle();
	return { bridge, bot, flux, openai, requests, sent, end };
}

type Realtime = Awaited<ReturnType<typeof realtimeMeeting>>;

const creates = (live: Realtime) =>
	live.openai.types().filter((type) => type === "response.create").length;
const systemTexts = (live: Realtime) =>
	live.openai.sent
		.filter((event) => event.type === "conversation.item.create")
		.map(
			(event) =>
				event.item as { role?: string; content?: { text: string }[] },
		)
		.filter((item) => item.role === "system")
		.map((item) => item.content?.[0]?.text ?? "");
const botFrames = (live: Realtime) =>
	live.sent.filter((message) =>
		message.includes('"realtime_audio.bot_output"'),
	).length;
const realtimeTurns = (live: Realtime) =>
	live.requests.filter((r) => r.path.endsWith("/turns"));

function said(
	live: Realtime,
	event: "Update" | "EndOfTurn",
	turnIndex: number,
	window: [number, number],
	transcript: string,
	words?: Array<{ word: string; start: number; end: number }>,
) {
	live.flux.emit({
		event,
		turn_index: turnIndex,
		audio_window_start: window[0],
		audio_window_end: window[1],
		transcript,
		...(words ? { words } : {}),
	});
}

/** The voice's response `id`, its audio, and the calls it ends with. */
function respond(
	live: Realtime,
	id: string,
	output: unknown[] = [],
	audioBytes = 0,
) {
	live.openai.emit({ type: "response.created", response: { id } });
	if (audioBytes > 0) {
		live.openai.emit({
			type: "response.output_audio.delta",
			response_id: id,
			item_id: `item_${id}`,
			delta: Buffer.alloc(audioBytes).toString("base64"),
		});
	}
	live.openai.emit({
		type: "response.done",
		response: { id, status: "completed", output },
	});
}

const askFabric = (callId: string, request: string) => ({
	type: "function_call",
	call_id: callId,
	name: "ask_fabric",
	arguments: JSON.stringify({ request }),
});

test("the realtime voice answers a question asked over another participant's sentence once, for its asker, and talk over its answer cuts nothing", async (t) => {
	const live = await realtimeMeeting();
	t.after(() => live.end());
	await live.bridge.onRequest(
		speaking([
			[ana, 0, 3.2],
			[bo, 3, 5],
		]),
	);
	const transcript =
		"I think we can call it done. Parlume, what is the status of F-12?";
	const starts = [
		0.2, 0.5, 0.8, 1.1, 1.5, 1.9, 2.3, 3.3, 3.7, 3.9, 4.0, 4.2, 4.5, 4.6,
	];
	said(
		live,
		"EndOfTurn",
		0,
		[0.1, 4.9],
		transcript,
		transcript.split(" ").map((word, index) => ({
			word,
			start: starts[index] ?? 4.7,
			end: (starts[index] ?? 4.7) + 0.2,
		})),
	);
	await settle();

	assert.equal(creates(live), 1, "answered once, without a repeat");
	assert.ok(
		systemTexts(live).some((text) =>
			text.startsWith("Bo Example just addressed you"),
		),
		"answered for the one who asked",
	);

	const framesBefore = botFrames(live);
	live.openai.emit({ type: "response.created", response: { id: "resp_1" } });
	live.openai.emit({
		type: "response.output_audio.delta",
		response_id: "resp_1",
		item_id: "item_resp_1",
		delta: Buffer.alloc(9_600).toString("base64"),
	});
	await live.bridge.onRequest(speaking([[ana, 5.2, 7]]));
	said(live, "Update", 1, [5.2, 6], "and the logs");
	await settle();
	said(live, "EndOfTurn", 1, [5.2, 7], "and the logs look clean so far.");
	await settle();
	live.openai.emit({
		type: "response.done",
		response: { id: "resp_1", status: "completed", output: [] },
	});
	await settle();

	assert.ok(botFrames(live) > framesBefore, "the answer reaches the bot");
	assert.equal(live.openai.types().includes("response.cancel"), false);
	assert.equal(
		live.openai.types().includes("conversation.item.truncate"),
		false,
	);
	assert.equal(
		live.requests.some((r) => r.path.endsWith("/interrupt")),
		false,
	);
	assert.equal(creates(live), 1, "Ana's talk is not answered");
	assert.deepEqual(realtimeTurns(live), []);
});

test("another participant talking while a realtime Fabric job runs leaves the job current, and its result is answered", async (t) => {
	const live = await realtimeMeeting();
	t.after(() => live.end());
	await live.bridge.onRequest(
		speaking([
			[ana, 0, 2],
			[bo, 2.5, 4.5],
		]),
	);
	said(
		live,
		"EndOfTurn",
		0,
		[0.1, 1.5],
		"Hey Fabric, what coding instructions are connected to this project?",
	);
	await settle();
	respond(live, "resp_1", [
		askFabric(
			"call_1",
			"Which coding instructions are connected to this project?",
		),
	]);
	await settle();
	const turn = realtimeTurns(live)[0];
	assert.equal(turn?.body.delivery, "realtime");
	assert.equal(turn?.body.job, "J1");
	assert.equal(turn?.body.speakerName, ana.name);
	respond(live, "resp_2", [], 4_800);
	await settle();
	const before = creates(live);

	said(live, "Update", 1, [2.6, 3.2], "I think the export");
	await settle();
	said(
		live,
		"EndOfTurn",
		1,
		[2.6, 4.4],
		"I think the export fix should go first.",
	);
	await settle();

	assert.equal(creates(live), before, "Bo's talk starts nothing");
	assert.equal(live.openai.types().includes("response.cancel"), false);
	assert.equal(
		realtimeTurns(live).length,
		1,
		"the request is not asked again",
	);
	const state = plain(
		await (
			await live.bridge.onRequest(
				control("verify-generation", {
					voiceGeneration: turn?.body.voiceGeneration,
				}),
			)
		).json(),
	);
	assert.equal(state.current, true, "the job may still act");

	const delivered = plain(
		await (
			await live.bridge.onRequest(
				control("fabric-result", {
					job: "J1",
					status: "completed",
					text: "This project uses the coding instructions repository.",
					chatTags: [],
					turnId: "turn-1",
				}),
			)
		).json(),
	);
	assert.deepEqual(delivered, { accepted: true });
	// It waits for the holding line before it to finish playing.
	await waitFor(() =>
		systemTexts(live).some((text) =>
			text.includes(
				"This project uses the coding instructions repository.",
			),
		),
	);
	assert.equal(live.openai.types().at(-1), "response.create");
	const framesBefore = botFrames(live);
	respond(live, "resp_3", [], 9_600);
	await waitFor(() => botFrames(live) > framesBefore);
});

test("a link asked for by voice in a realtime group meeting is looked up by Fabric for its asker, posted to this meeting's bot, confirmed, and the voice is told it is being posted", async (t) => {
	const live = await realtimeMeeting();
	t.after(() => live.end());
	await live.bridge.onRequest(
		speaking([
			[ana, 0, 2],
			[bo, 2, 5],
		]),
	);
	said(
		live,
		"EndOfTurn",
		0,
		[0.1, 1.9],
		"The coding instructions moved last week.",
	);
	await settle();
	said(
		live,
		"EndOfTurn",
		1,
		[2.1, 4.9],
		"Hey Fabric, can you give the direct link to coding instructions in the chat, please?",
	);
	await settle();
	assert.ok(
		systemTexts(live).some((text) =>
			text.startsWith("Bo Example just addressed you"),
		),
	);
	respond(live, "resp_1", [
		askFabric(
			"call_1",
			"Post the direct link to the coding instructions repository in the meeting chat",
		),
	]);
	await settle();
	const turn = realtimeTurns(live)[0];
	assert.equal(turn?.body.speakerName, bo.name);
	assert.equal(turn?.body.job, "J1");
	respond(live, "resp_2");
	await settle();

	const sent = plain(
		await (
			await live.bridge.onRequest(
				control("chat", {
					message: `Coding instructions: ${LINK}`,
					turnId: "turn-1",
					voiceGeneration: turn?.body.voiceGeneration,
				}),
			)
		).json(),
	);
	assert.deepEqual(sent, { sent: true, tag: "P1", delivery: "queued" });
	const posts = live.requests.filter((r) => r.path.endsWith("/chat"));
	assert.deepEqual(
		posts.map((r) => r.body),
		[
			{
				sessionId: "session-1",
				botId: "bot_abc123",
				message: `[P1] Coding instructions: ${LINK}`,
				turnId: "turn-1",
			},
		],
	);
	await live.bridge.onRequest(
		parlumePost("msg_1", `[P1] Coding instructions: ${LINK}`),
	);
	await settle();
	const confirmed = live.requests.find((r) =>
		r.path.endsWith("/chat-delivery"),
	);
	assert.equal(confirmed?.body.turnId, "turn-1");
	assert.equal(confirmed?.body.outcome, "confirmed");

	await live.bridge.onRequest(
		control("fabric-result", {
			job: "J1",
			status: "completed",
			text: `Coding instructions: ${LINK}`,
			chatTags: ["P1"],
			turnId: "turn-1",
		}),
	);
	await settle();
	assert.match(
		systemTexts(live).at(-1) ?? "",
		/being posted to the meeting chat as P1; do not post it again/,
	);
	assert.equal(live.openai.types().at(-1), "response.create");
});

test("in the realtime voice a link request lost under overlapping speech arms nothing; its clear repeat reaches Fabric, and a post Fabric cannot deliver is told to the voice as not finished", async (t) => {
	const live = await realtimeMeeting({ failing: ["/chat"] });
	t.after(() => live.end());
	await live.bridge.onRequest(
		speaking([
			[ana, 0, 3],
			[bo, 1, 3.5],
			[ana, 5, 7],
		]),
	);
	said(
		live,
		"EndOfTurn",
		0,
		[0.1, 3.4],
		"so the export fix goes first thank you can you give the direct link to coding instructions in the chat please",
	);
	await settle();
	assert.equal(creates(live), 0, "not recognised: the voice does not answer");
	assert.equal(
		live.openai.types().includes("input_audio_buffer.append"),
		false,
	);

	said(
		live,
		"EndOfTurn",
		1,
		[5.1, 6.9],
		"Hey Fabric, could you please give me the direct link to the coding instructions in the chat?",
	);
	await settle();
	assert.equal(creates(live), 1);
	assert.ok(
		systemTexts(live).some((text) =>
			text.startsWith("Ana Example just addressed you"),
		),
	);
	respond(live, "resp_1", [
		askFabric(
			"call_1",
			"Post the direct link to the coding instructions repository in the meeting chat",
		),
	]);
	await settle();
	const turn = realtimeTurns(live)[0];
	assert.equal(turn?.body.speakerName, ana.name);
	respond(live, "resp_2");
	await settle();

	const sent = plain(
		await (
			await live.bridge.onRequest(
				control("chat", {
					message: `Coding instructions: ${LINK}`,
					turnId: "turn-1",
					voiceGeneration: turn?.body.voiceGeneration,
				}),
			)
		).json(),
	);
	assert.deepEqual(sent, { sent: false, reason: "failed" });

	await live.bridge.onRequest(
		control("fabric-result", {
			job: "J1",
			status: "failed",
			text: "",
			chatTags: [],
			turnId: "turn-1",
		}),
	);
	await settle();
	const last = systemTexts(live).at(-1) ?? "";
	assert.match(last, /^Fabric could not finish J1/);
	assert.doesNotMatch(last, /being posted to the meeting chat/);
	assert.equal(live.openai.types().at(-1), "response.create");
});
