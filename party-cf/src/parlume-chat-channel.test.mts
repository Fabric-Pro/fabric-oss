import assert from "node:assert/strict";
import test from "node:test";
import { loadParlumeModule } from "./parlume-test-runtime.mts";

// Objects built inside the sandboxed module have that realm's prototypes.
const plain = (value: unknown) => JSON.parse(JSON.stringify(value));
const flush = () => new Promise((resolve) => setImmediate(resolve));

type Channel = {
	send(body: unknown): Promise<Response>;
	receive(body: unknown): Promise<Response>;
	checkDeliveries(): Promise<void>;
	runSuggestionPass(input: { enabled: boolean }): Promise<void>;
	nextWakeAt(input: { suggestions: boolean }): Promise<number | null>;
	noteSpeechSegment(): boolean;
	beginChatTurn(generation: number): void;
	isChatTurnCurrent(generation: number): boolean;
	isAvailable(): Promise<boolean>;
	spokenReference(command: {
		kind: "say" | "go" | "more";
		tag: string;
	}): Promise<{ kind: "speak" | "ask"; text: string } | null>;
};

const UNAVAILABLE =
	"I can't write in this meeting's chat. Guests may not have chat here.";

function harness(
	options: {
		fabric?: (path: string, body: Record<string, unknown>) => Response;
	} = {},
) {
	const clock = { now: 1_000_000 };
	const state = { busy: false, speaks: true };
	const data = new Map<string, unknown>();
	const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
	const spoken: string[] = [];
	const turns: Array<Record<string, unknown>> = [];
	const segments: Array<Record<string, unknown>> = [];
	const logs: Array<{ event: string; meta: Record<string, unknown> }> = [];
	const wakes: number[] = [];
	let interrupts = 0;
	let activity = 0;
	const { ParlumeChatChannel } = loadParlumeModule(
		"./parlume-chat-channel.ts",
		async () => Response.json({}),
	) as { ParlumeChatChannel: new (host: unknown) => Channel };
	const channel = new ParlumeChatChannel({
		storage: {
			get: async (key: string) => data.get(key),
			put: async (key: string, value: unknown) => {
				data.set(key, value);
			},
		},
		postToFabric: async (path: string, body: Record<string, unknown>) => {
			requests.push({ path, body: plain(body) });
			const response =
				options.fabric?.(path, body) ??
				Response.json({ accepted: true });
			return response.ok ? response : null;
		},
		bot: async () => ({ sessionId: "session-1", botId: "bot-1" }),
		isParlumeSender: (name: string | null) => name === "Fabric Parlume",
		isBusy: () => state.busy,
		speak: async (text: string) => {
			spoken.push(text);
			return state.speaks;
		},
		interrupt: async () => {
			interrupts++;
		},
		dispatchTurn: async (turn: unknown) => {
			turns.push(plain(turn));
		},
		persistSegment: (_bot: unknown, message: unknown) => {
			segments.push(plain(message));
		},
		noteActivity: async () => {
			activity++;
		},
		wakeAt: (at: number) => wakes.push(at),
		log: (_level: string, event: string, meta: Record<string, unknown>) =>
			logs.push({ event, meta: plain(meta) }),
		now: () => clock.now,
	});
	return {
		channel,
		clock,
		state,
		requests,
		spoken,
		turns,
		segments,
		logs,
		wakes,
		interrupts: () => interrupts,
		activity: () => activity,
		posts: () => requests.filter((r) => r.path.endsWith("/chat")),
		reports: () =>
			requests.filter((r) => r.path.endsWith("/chat-delivery")),
		events: (name: string) => logs.filter((entry) => entry.event === name),
	};
}

let messageNumber = 0;
function chatMessage(text: string, overrides: Record<string, unknown> = {}) {
	messageNumber++;
	return {
		id: `msg_${messageNumber}`,
		text,
		senderName: "Dev One",
		senderId: "participant-1",
		toBot: false,
		timestampMs: 1_000_000,
		...overrides,
	};
}

test("a post is tagged, sent through Fabric and reported only as queued", async () => {
	const meeting = harness();

	const first = plain(
		await (await meeting.channel.send({ message: "Here is F-12." })).json(),
	);
	const second = plain(
		await (await meeting.channel.send({ message: "And F-13." })).json(),
	);

	assert.deepEqual(first, { sent: true, tag: "P1", delivery: "queued" });
	assert.equal(second.tag, "P2");
	assert.deepEqual(
		meeting.posts().map((r) => r.body),
		[
			{
				sessionId: "session-1",
				botId: "bot-1",
				message: "[P1] Here is F-12.",
			},
			{
				sessionId: "session-1",
				botId: "bot-1",
				message: "[P2] And F-13.",
			},
		],
	);
	assert.deepEqual(meeting.wakes, [1_015_000, 1_015_000]);
	assert.equal(meeting.events("chat.forwarded")[0]?.meta.delivery, "queued");
});

test("a participant's message keeps the meeting from going idle; Parlume's own post and a redelivery do not", async () => {
	const meeting = harness();
	await meeting.channel.send({ message: "Here is F-12." });
	const message = chatMessage("@Parlume what is open?");

	await meeting.channel.receive(message);
	await meeting.channel.receive(message);
	await meeting.channel.receive(
		chatMessage("[P1] Here is F-12.", { senderName: "Fabric Parlume" }),
	);

	assert.equal(meeting.activity(), 1);
});

test("a post's own tag coming back confirms it and is never treated as a request", async () => {
	const meeting = harness();
	await meeting.channel.send({ message: "stop", turnId: "turn-1" });
	meeting.clock.now += 1_500;

	await meeting.channel.receive(
		chatMessage("[P1] stop", { senderName: "Fabric Parlume" }),
	);
	await flush();

	assert.equal(meeting.events("chat.confirmed")[0]?.meta.latencyMs, 1_500);
	assert.deepEqual(meeting.reports()[0]?.body, {
		sessionId: "session-1",
		botId: "bot-1",
		turnId: "turn-1",
		tag: "P1",
		kind: "reply",
		outcome: "confirmed",
		latencyMs: 1_500,
	});
	assert.equal(meeting.interrupts(), 0);
	assert.equal(meeting.segments[0]?.text, "[P1] stop");
	await meeting.channel.checkDeliveries();
	assert.equal(meeting.events("chat.unconfirmed").length, 0);
});

test("with nothing ever seen in the chat, a missing post marks it unavailable, Parlume says so once, and later posts are refused at once", async () => {
	const meeting = harness();
	await meeting.channel.send({ message: "The link", turnId: "turn-1" });
	meeting.clock.now += 14_999;
	await meeting.channel.checkDeliveries();
	assert.equal(meeting.reports().length, 0);

	meeting.clock.now += 1;
	await meeting.channel.checkDeliveries();
	await meeting.channel.checkDeliveries();

	assert.equal(meeting.events("chat.unconfirmed")[0]?.meta.latencyMs, 15_000);
	assert.equal(meeting.events("chat.unavailable").length, 1);
	assert.deepEqual(
		meeting.reports().map((r) => r.body.outcome),
		["unavailable"],
	);
	assert.deepEqual(meeting.spoken, [UNAVAILABLE]);

	const refused = plain(
		await (await meeting.channel.send({ message: "Another" })).json(),
	);
	assert.deepEqual(refused, { sent: false, reason: "chat_unavailable" });
	assert.equal(meeting.posts().length, 1);
});

test("a message from anyone clears the unavailable mark", async () => {
	const meeting = harness();
	await meeting.channel.send({ message: "The link" });
	meeting.clock.now += 15_000;
	await meeting.channel.checkDeliveries();

	await meeting.channel.receive(chatMessage("Can anyone see this?"));
	const resent = plain(
		await (await meeting.channel.send({ message: "Again" })).json(),
	);

	assert.equal(meeting.events("chat.available").length, 1);
	assert.deepEqual(resent, { sent: true, tag: "P2", delivery: "queued" });
});

test("a missing post in a chat that works is only unconfirmed", async () => {
	const meeting = harness();
	await meeting.channel.receive(chatMessage("Morning all"));
	await meeting.channel.send({ message: "The link", turnId: "turn-1" });
	meeting.clock.now += 16_000;

	await meeting.channel.checkDeliveries();

	assert.deepEqual(
		meeting.reports().map((r) => r.body.outcome),
		["unconfirmed"],
	);
	assert.equal(meeting.events("chat.unavailable").length, 0);
	assert.deepEqual(meeting.spoken, []);
});

test("the unavailable notice waits until Parlume is not speaking, and is retried if it could not be said", async () => {
	const meeting = harness();
	await meeting.channel.send({ message: "The link" });
	meeting.clock.now += 15_000;
	meeting.state.busy = true;
	await meeting.channel.checkDeliveries();
	assert.deepEqual(meeting.spoken, []);

	meeting.state.busy = false;
	meeting.state.speaks = false;
	await meeting.channel.checkDeliveries();
	meeting.state.speaks = true;
	await meeting.channel.checkDeliveries();
	await meeting.channel.checkDeliveries();

	assert.deepEqual(meeting.spoken, [UNAVAILABLE, UNAVAILABLE]);
});

test("a typed request addressed to Parlume becomes a request answered in the chat; a redelivered one does not", async () => {
	const meeting = harness();
	const request = chatMessage("@Fabric Parlume what changed?");

	await meeting.channel.receive(request);
	await meeting.channel.receive(request);
	await flush();

	assert.deepEqual(meeting.turns, [
		{
			speakerName: "Dev One",
			speakerId: "participant-1",
			chatMessageId: request.id,
			text: "what changed?",
			replyChannel: "CHAT",
		},
	]);
	assert.equal(meeting.segments.length, 1);
});

test("a typed request asking to be said aloud is answered by voice", async () => {
	const meeting = harness();

	await meeting.channel.receive(
		chatMessage("Fabric, tell everyone the release date"),
	);
	await flush();

	assert.equal(meeting.turns[0]?.replyChannel, "VOICE");
	assert.equal(meeting.turns[0]?.text, "tell everyone the release date");
});

test("say, go, more and stop act on tagged posts; an unknown tag and an unaddressed remark do nothing", async () => {
	const meeting = harness();
	await meeting.channel.send({ message: "F-12 ships Friday." });

	await meeting.channel.receive(chatMessage("say P1"));
	await meeting.channel.receive(chatMessage("more P1"));
	await meeting.channel.receive(chatMessage("go P9"));
	await meeting.channel.receive(chatMessage("stop"));
	await meeting.channel.receive(chatMessage("nice work everyone"));
	await meeting.channel.receive(
		chatMessage("say P1", { senderName: "Fabric Parlume" }),
	);
	await flush();

	assert.deepEqual(meeting.spoken, ["F-12 ships Friday."]);
	assert.deepEqual(
		meeting.turns.map((turn) => [turn.text, turn.replyChannel]),
		[
			[
				"More detail on what Parlume posted in the meeting chat as P1 (the label of that chat message, not a work item ID): F-12 ships Friday.",
				"CHAT",
			],
		],
	);
	assert.equal(meeting.interrupts(), 1);
	assert.equal(
		meeting.events("chat.command_unknown_post")[0]?.meta.tag,
		"P9",
	);
});

test("a held change is posted with its go handle, and go asks for it again in the chat once", async () => {
	const meeting = harness();

	const sent = plain(
		await (
			await meeting.channel.send({
				held: {
					action: "create the work item “Export”",
					request: "create a work item called Export",
				},
				turnId: "turn-1",
			})
		).json(),
	);
	await meeting.channel.receive(chatMessage("go P1"));
	await meeting.channel.receive(chatMessage("go P1"));
	await flush();

	assert.deepEqual(sent, { sent: true, tag: "P1", delivery: "queued" });
	assert.equal(
		meeting.posts()[0]?.body.message,
		'[P1] I did not create the work item “Export” because I was interrupted. Reply "go P1" to do it.',
	);
	assert.deepEqual(
		meeting.turns.map((turn) => [turn.text, turn.replyChannel]),
		[["create a work item called Export", "CHAT"]],
	);
	assert.deepEqual(meeting.spoken, []);
	assert.equal(meeting.events("chat.held_already_run").length, 1);
});

test("a spoken reference gets the same post action for the caller to answer by voice", async () => {
	const meeting = harness();
	await meeting.channel.send({
		message: "Two open features: F-12 and F-13.",
	});
	await meeting.channel.send({
		held: {
			action: "create the work item “Export”",
			request: "create a work item called Export",
		},
		turnId: "turn-1",
	});

	assert.deepEqual(
		plain(await meeting.channel.spokenReference({ kind: "go", tag: "P1" })),
		{ kind: "speak", text: "Two open features: F-12 and F-13." },
	);
	assert.deepEqual(
		plain(
			await meeting.channel.spokenReference({ kind: "more", tag: "P1" }),
		),
		{
			kind: "ask",
			text: "More detail on what Parlume posted in the meeting chat as P1 (the label of that chat message, not a work item ID): Two open features: F-12 and F-13.",
		},
	);
	assert.deepEqual(
		plain(await meeting.channel.spokenReference({ kind: "go", tag: "P2" })),
		{ kind: "ask", text: "create a work item called Export" },
	);
	assert.equal(
		await meeting.channel.spokenReference({ kind: "go", tag: "P2" }),
		null,
	);
	assert.equal(
		await meeting.channel.spokenReference({ kind: "say", tag: "P9" }),
		null,
	);
	assert.deepEqual(meeting.turns, []);
	assert.deepEqual(meeting.spoken, []);
});

test("a held change without its request is refused", async () => {
	const meeting = harness();

	const response = await meeting.channel.send({
		held: { action: "create the work item", request: " " },
	});

	assert.equal(response.status, 400);
	assert.equal(meeting.posts().length, 0);
});

test("the chat counts as available until a post goes unseen in a silent chat", async () => {
	const meeting = harness();
	assert.equal(await meeting.channel.isAvailable(), true);

	await meeting.channel.send({ message: "Here is F-12." });
	meeting.clock.now += 15_000;
	await meeting.channel.checkDeliveries();

	assert.equal(await meeting.channel.isAvailable(), false);
});

test("a suggestion pass asks Fabric only when due, posts one with its go handle, and go speaks just the suggestion", async () => {
	const meeting = harness({
		fabric: (path) =>
			path.endsWith("/suggest")
				? Response.json({
						suggest: true,
						text: "F-12 already covers this.",
						speaker: "Sam",
						quote: "we still need an export",
						topic: "Roadmap export",
					})
				: Response.json({ accepted: true }),
	});
	const suggests = () =>
		meeting.requests.filter((r) => r.path.endsWith("/suggest"));
	await meeting.channel.receive(chatMessage("Morning"));
	meeting.channel.noteSpeechSegment();
	await meeting.channel.runSuggestionPass({ enabled: true });
	assert.equal(suggests().length, 0, "one remark is not enough");

	// The first pass runs as soon as enough is said, with no interval to wait.
	meeting.channel.noteSpeechSegment();
	await meeting.channel.runSuggestionPass({ enabled: true });

	assert.deepEqual(suggests()[0]?.body, {
		sessionId: "session-1",
		botId: "bot-1",
		previous: [],
	});
	assert.equal(
		meeting.posts()[0]?.body.message,
		'[P1] Suggestion on Roadmap export, re Sam: "we still need an export". F-12 already covers this. (reply "go P1" and I\'ll say it)',
	);
	await meeting.channel.receive(chatMessage("go P1"));
	await flush();
	assert.deepEqual(meeting.spoken, [
		"Sam, on Roadmap export: F-12 already covers this.",
	]);

	// The counter starts again: no pass until two more segments.
	meeting.clock.now += 45_000;
	await meeting.channel.runSuggestionPass({ enabled: true });
	assert.equal(suggests().length, 1);
});

test("suggestions are skipped while disabled, busy or with the chat unavailable, and a near-duplicate is not posted", async () => {
	const meeting = harness({
		fabric: (path) =>
			path.endsWith("/suggest")
				? Response.json({
						suggest: true,
						text: "Ask who owns the export.",
						speaker: "Alex",
						quote: "someone should do the export",
						topic: "Export owner",
					})
				: Response.json({ accepted: true }),
	});
	const suggests = () =>
		meeting.requests.filter((r) => r.path.endsWith("/suggest"));
	const pass = async (enabled = true) => {
		for (let index = 0; index < 3; index++) {
			meeting.channel.noteSpeechSegment();
		}
		meeting.clock.now += 300_000;
		await meeting.channel.runSuggestionPass({ enabled });
	};
	await meeting.channel.receive(chatMessage("Morning"));
	await meeting.channel.runSuggestionPass({ enabled: true });

	await pass(false);
	meeting.state.busy = true;
	await pass();
	meeting.state.busy = false;
	assert.equal(suggests().length, 0);

	await pass();
	await pass();
	assert.equal(suggests().length, 2);
	assert.equal(meeting.posts().length, 1);
	assert.equal(meeting.events("suggestion.pass")[1]?.meta.duplicate, true);
	assert.deepEqual(suggests()[1]?.body.previous, [
		"Ask who owns the export.",
	]);
});

test("no suggestion pass while the chat is unavailable", async () => {
	const meeting = harness();
	await meeting.channel.send({ message: "The link" });
	meeting.clock.now += 15_000;
	await meeting.channel.checkDeliveries();
	for (let index = 0; index < 3; index++) {
		meeting.channel.noteSpeechSegment();
	}
	meeting.clock.now += 90_000;

	await meeting.channel.runSuggestionPass({ enabled: true });

	assert.equal(
		meeting.requests.filter((r) => r.path.endsWith("/suggest")).length,
		0,
	);
});

test("at most one suggestion every two minutes, ten an hour", async () => {
	const points = [
		"F-3 ships on Friday.",
		"Dana owns billing.",
		"The login bug is fixed in staging.",
		"Mobile was descoped last sprint.",
		"Security review passed Monday.",
		"Exports use the CSV template.",
		"Search indexing runs nightly.",
		"Pricing moved to the next quarter.",
		"Onboarding emails go out weekly.",
		"The audit log keeps ninety days.",
		"Reports render as PDF now.",
		"Webhooks retry three times.",
		"Dark mode landed in October.",
		"Invoices close at month end.",
	];
	let index = 0;
	const meeting = harness({
		fabric: (path) => {
			if (!path.endsWith("/suggest")) {
				return Response.json({ accepted: true });
			}
			const point = index++;
			return Response.json({
				suggest: true,
				text: points[point],
				speaker: "Sam",
				quote: `question ${point}`,
				topic: `Topic ${point}`,
			});
		},
	});
	await meeting.channel.receive(chatMessage("Morning"));
	await meeting.channel.runSuggestionPass({ enabled: true });
	const passEvery = async (ms: number, passes: number) => {
		for (let pass = 0; pass < passes; pass++) {
			for (let segment = 0; segment < 3; segment++) {
				meeting.channel.noteSpeechSegment();
			}
			meeting.clock.now += ms;
			await meeting.channel.runSuggestionPass({ enabled: true });
		}
	};
	// A pass every 45 seconds for 90 seconds: one post, then quiet.
	await passEvery(45_000, 2);
	assert.equal(meeting.posts().length, 1);

	await passEvery(120_000, 12);
	assert.equal(meeting.posts().length, 10);
});

test("a chat request is being answered until its final post or two minutes", async () => {
	const meeting = harness();
	meeting.channel.beginChatTurn(4);
	assert.equal(meeting.channel.isChatTurnCurrent(4), true);
	assert.equal(meeting.channel.isChatTurnCurrent(5), false);

	await meeting.channel.send({ message: "Part one", voiceGeneration: 4 });
	assert.equal(meeting.channel.isChatTurnCurrent(4), true);
	await meeting.channel.send({
		message: "Part two",
		voiceGeneration: 4,
		final: true,
	});
	assert.equal(meeting.channel.isChatTurnCurrent(4), false);

	meeting.channel.beginChatTurn(6);
	meeting.clock.now += 2 * 60 * 1000;
	assert.equal(meeting.channel.isChatTurnCurrent(6), false);
});

test("the next wake is the earliest future delivery deadline or suggestion pass", async () => {
	const meeting = harness();
	const wake = (suggestions = true) =>
		meeting.channel.nextWakeAt({ suggestions });
	assert.equal(await wake(), null, "nothing said: no pass to wake for");

	assert.equal(meeting.channel.noteSpeechSegment(), false);
	assert.equal(meeting.channel.noteSpeechSegment(), true, "enough said");
	assert.equal(meeting.channel.noteSpeechSegment(), false);
	assert.equal(await wake(), 1_005_000, "the first pass: right away");
	assert.equal(await wake(false), null, "suggestions off");

	meeting.state.busy = true;
	await meeting.channel.runSuggestionPass({ enabled: true });
	meeting.clock.now += 60_000;
	assert.equal(
		await wake(),
		1_065_000,
		"due but busy: shortly, not in a tight loop",
	);
	meeting.state.busy = false;
	await meeting.channel.runSuggestionPass({ enabled: true });
	meeting.channel.noteSpeechSegment();
	meeting.channel.noteSpeechSegment();
	assert.equal(await wake(), 1_105_000, "the pass interval after a pass");

	await meeting.channel.send({ message: "The link" });
	assert.equal(await wake(false), 1_075_000);
});

test("a due pass waits for the gap after the last post, not for the next timer", async () => {
	const meeting = harness({
		fabric: (path) =>
			path.endsWith("/suggest")
				? Response.json({
						suggest: true,
						text: "F-12 already covers this.",
						speaker: "Sam",
						quote: "we still need an export",
						topic: "Roadmap export",
					})
				: Response.json({ accepted: true }),
	});
	await meeting.channel.receive(chatMessage("Morning"));
	await meeting.channel.runSuggestionPass({ enabled: true });
	meeting.channel.noteSpeechSegment();
	meeting.channel.noteSpeechSegment();
	meeting.clock.now += 45_000;
	await meeting.channel.runSuggestionPass({ enabled: true });
	assert.equal(meeting.posts().length, 1);
	const postedAt = meeting.clock.now;
	await meeting.channel.receive(
		chatMessage(String(meeting.posts()[0]?.body.message), {
			senderName: "Fabric Parlume",
		}),
	);

	meeting.channel.noteSpeechSegment();
	meeting.channel.noteSpeechSegment();
	assert.equal(
		await meeting.channel.nextWakeAt({ suggestions: true }),
		postedAt + 120_000,
	);
});

test("malformed bodies are refused", async () => {
	const meeting = harness();
	assert.equal((await meeting.channel.send({ message: "  " })).status, 400);
	assert.equal(
		(await meeting.channel.send({ message: "x".repeat(8_001) })).status,
		400,
	);
	assert.equal(
		(await meeting.channel.receive({ text: "no id" })).status,
		400,
	);
});
