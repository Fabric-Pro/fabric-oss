import assert from "node:assert/strict";
import test from "node:test";
import { loadParlumeModule } from "./parlume-test-runtime.mts";

// Objects built inside the sandboxed module have that realm's prototypes.
const plain = (value: unknown) => JSON.parse(JSON.stringify(value));
const flush = () => new Promise((resolve) => setImmediate(resolve));

type Audience = "MEETING" | "TEAM";

type Channel = {
	send(body: unknown): Promise<Response>;
	receive(body: unknown): Promise<Response>;
	checkDeliveries(): Promise<void>;
	runSuggestionPass(input: {
		enabled: boolean;
		audience: Audience;
	}): Promise<void>;
	nextWakeAt(input: {
		suggestions: boolean;
		audience: Audience;
	}): Promise<number | null>;
	noteSpeechSegment(): boolean;
	beginChatTurn(generation: number): void;
	isChatTurnCurrent(generation: number): boolean;
	isAvailable(): Promise<boolean>;
	recentMessages(): Array<{ from: string | null; text: string }>;
	startTagsAt(first: number): Promise<void>;
	spokenReference(command: {
		kind: "say" | "go" | "more";
		tag: string;
	}): Promise<{ kind: "speak" | "ask"; text: string } | null>;
	giveJoinNotice(notice: { text: string; spoken: string }): Promise<void>;
	expectJoinNotice(): Promise<void>;
	postHeldRecap(): Promise<void>;
	noteGuestArrived(): Promise<void>;
	postNotice(text: string, essential?: boolean): Promise<unknown>;
	postFromVoice(text: string): Promise<unknown>;
	leaving(body?: unknown): Promise<Response>;
};

const UNAVAILABLE =
	"I can't write in this meeting's chat. Guests may not have chat here.";
const UNAVAILABLE_GRACE_MS = 5_000;

function harness(
	options: {
		fabric?: (
			path: string,
			body: Record<string, unknown>,
		) => Response | Promise<Response>;
		storage?: Map<string, unknown>;
		beforePut?: (entries: Record<string, unknown>) => void;
		beforeActivity?: () => void;
		/** The session has no bot in the meeting. */
		noBot?: boolean;
	} = {},
) {
	const clock = { now: 1_000_000 };
	// `speech`: Parlume's voice is still sending what it holds until it settles.
	const state: {
		busy: boolean;
		speaks: boolean;
		speech: Promise<void> | null;
	} = { busy: false, speaks: true, speech: null };
	const guests = { present: false, ids: new Set<string>() };
	const data = options.storage ?? new Map<string, unknown>();
	const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
	const spoken: string[] = [];
	const turns: Array<Record<string, unknown>> = [];
	const segments: Array<Record<string, unknown>> = [];
	const logs: Array<{ event: string; meta: Record<string, unknown> }> = [];
	const wakes: number[] = [];
	let interrupts = 0;
	const stops: Array<Record<string, unknown>> = [];
	const pauses: Array<Record<string, unknown>> = [];
	const stoppedGenerations = new Set<number>();
	let activity = 0;
	const { ParlumeChatChannel } = loadParlumeModule(
		"./parlume-chat-channel.ts",
		async () => Response.json({}),
	) as { ParlumeChatChannel: new (host: unknown) => Channel };
	const requestFabric = async (
		path: string,
		body: Record<string, unknown>,
	) => {
		requests.push({ path, body: plain(body) });
		// Only an answer the test holds back waits.
		const answer = options.fabric?.(path, body);
		return (
			(answer instanceof Promise ? await answer : answer) ??
			Response.json({ accepted: true })
		);
	};
	const channel = new ParlumeChatChannel({
		storage: {
			get: async (key: string) => structuredClone(data.get(key)),
			put: async (
				key: string | Record<string, unknown>,
				value?: unknown,
			) => {
				const entries =
					typeof key === "string" ? { [key]: value } : key;
				options.beforePut?.(entries);
				const copied = structuredClone(entries);
				for (const [name, entry] of Object.entries(copied)) {
					data.set(name, entry);
				}
			},
			delete: async (key: string) => data.delete(key),
		},
		postToFabric: async (path: string, body: Record<string, unknown>) => {
			const response = await requestFabric(path, body);
			return response.ok ? response : null;
		},
		requestFabric,
		bot: async () =>
			options.noBot ? null : { sessionId: "session-1", botId: "bot-1" },
		isParlumeSender: (name: string | null) => name === "Fabric Parlume",
		guests: {
			get open() {
				return !guests.present;
			},
			isGuest: (id: string | null) => id !== null && guests.ids.has(id),
		},
		isBusy: () => state.busy,
		whenSpeechSent: () => state.speech,
		speak: async (text: string) => {
			spoken.push(text);
			return state.speaks;
		},
		speakJoinNotice: async (text: string) => {
			spoken.push(text);
			return state.speaks;
		},
		stop: async (actor: unknown) => {
			interrupts++;
			stops.push(plain(actor));
		},
		pause: async (actor: unknown) => {
			pauses.push(plain(actor));
		},
		isStopped: (generation: number) => stoppedGenerations.has(generation),
		dispatchTurn: async (turn: unknown) => {
			turns.push(plain(turn));
		},
		persistSegment: (_bot: unknown, message: unknown) => {
			segments.push(plain(message));
		},
		noteActivity: async () => {
			options.beforeActivity?.();
			activity++;
		},
		wakeAt: (at: number) => wakes.push(at),
		log: (_level: string, event: string, meta: Record<string, unknown>) =>
			logs.push({ event, meta: plain(meta) }),
		now: () => clock.now,
	});
	return {
		channel,
		data,
		clock,
		state,
		guests,
		requests,
		spoken,
		turns,
		segments,
		logs,
		wakes,
		interrupts: () => interrupts,
		stops,
		pauses,
		stoppedGenerations,
		activity: () => activity,
		posts: () => requests.filter((r) => r.path.endsWith("/chat")),
		reports: () =>
			requests.filter((r) => r.path.endsWith("/chat-delivery")),
		events: (name: string) => logs.filter((entry) => entry.event === name),
	};
}

const records = (meeting: ReturnType<typeof harness>) =>
	meeting.requests.filter((r) => r.path.endsWith("/suggestions"));

/** A meeting whose every pass Fabric answers with this suggestion. */
function suggesting(answer: Record<string, unknown>) {
	return harness({
		fabric: (path) =>
			path.endsWith("/suggest")
				? Response.json({
						suggest: true,
						text: "Who signs off the migration?",
						speaker: "Alex",
						quote: "we move the data in March",
						topic: "Data migration",
						...answer,
					})
				: Response.json({ accepted: true }),
	});
}

/** Enough speech for a due pass, then the pass, for the verified audience. */
async function passAfter(
	meeting: ReturnType<typeof harness>,
	ms: number,
	audience: Audience = "MEETING",
) {
	for (let index = 0; index < 3; index++) {
		meeting.channel.noteSpeechSegment();
	}
	meeting.clock.now += ms;
	await meeting.channel.runSuggestionPass({ enabled: true, audience });
}

/** Marks the chat unavailable: it has shown nothing, and a post never appears. */
async function loseChat(meeting: ReturnType<typeof harness>) {
	await meeting.channel.send({ message: "The link" });
	meeting.clock.now += 15_000;
	await meeting.channel.checkDeliveries();
	assert.equal(await meeting.channel.isAvailable(), false);
	await sayUnavailable(meeting);
}

/** Lets the grace after the chat was marked out of reach pass, then checks. */
async function sayUnavailable(meeting: ReturnType<typeof harness>) {
	meeting.clock.now += UNAVAILABLE_GRACE_MS;
	await meeting.channel.checkDeliveries();
}

const suggestPasses = (meeting: ReturnType<typeof harness>) =>
	meeting.requests.filter((r) => r.path.endsWith("/suggest")).length;

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

test("Graph commands remain deduplicated beyond 200 messages and a bridge restart", async () => {
	const meeting = harness();
	await meeting.channel.send({ message: "Current project status." });
	const original = chatMessage("say P1", { id: "graph:1700000000000" });
	await meeting.channel.receive(original);
	await flush();
	assert.equal(meeting.spoken.length, 1);
	for (let index = 1; index <= 201; index++) {
		await meeting.channel.receive(
			chatMessage("A participant observation.", {
				id: `graph:${1700000000000 + index}`,
			}),
		);
	}
	assert.equal(
		(await (await meeting.channel.receive(original)).json()).duplicate,
		true,
	);
	assert.equal(meeting.spoken.length, 1);
	const restarted = harness({ storage: meeting.data });
	assert.equal(
		(await (await restarted.channel.receive(original)).json()).duplicate,
		true,
	);
	await flush();
	assert.equal(restarted.spoken.length, 0);
});

test("concurrent Graph notification retries claim a command once", async () => {
	const meeting = harness();
	const original = chatMessage("Hey Fabric, what changed?", {
		id: "graph:1700000000000",
	});
	await Promise.all([
		meeting.channel.receive(original),
		meeting.channel.receive(original),
	]);
	await flush();
	assert.equal(meeting.turns.length, 1);
});

test("Graph receipt capacity fails closed without evicting old replay protection", async () => {
	const meeting = harness({
		storage: new Map([["graphChatMessageCount", 10_000]]),
	});
	const response = await meeting.channel.receive(
		chatMessage("Hey Fabric, what changed?", { id: "graph:1700000000000" }),
	);
	assert.equal(response.status, 429);
	assert.equal(meeting.turns.length, 0);
});

for (const failedKey of ["graphChatMessageCount", "chat"]) {
	test(`Graph storage preparation failure at ${failedKey} leaves its command retryable`, async () => {
		let fail = true;
		const meeting = harness({
			beforePut: (entries) => {
				if (failedKey in entries && fail) {
					fail = false;
					throw new Error("injected pre-dispatch storage failure");
				}
			},
		});
		const message = chatMessage("Hey Fabric, what changed?", {
			id: "graph:1700000000000",
		});
		await assert.rejects(
			meeting.channel.receive(message),
			/injected pre-dispatch storage failure/,
		);
		assert.equal(meeting.turns.length, 0);
		assert.equal(
			meeting.data.has("graphChatMessage:graph:1700000000000"),
			false,
		);
		await meeting.channel.receive(message);
		await flush();
		assert.equal(meeting.turns.length, 1);
	});
}

test("Graph activity preparation failure leaves no receipt before dispatch", async () => {
	let fail = true;
	const meeting = harness({
		beforeActivity: () => {
			if (fail) {
				fail = false;
				throw new Error("injected activity failure");
			}
		},
	});
	const message = chatMessage("Hey Fabric, what changed?", {
		id: "graph:1700000000000",
	});
	await assert.rejects(
		meeting.channel.receive(message),
		/injected activity failure/,
	);
	await meeting.channel.receive(message);
	await flush();
	assert.equal(meeting.turns.length, 1);
});

test("Graph participant questions use proven post ownership rather than a provider bot display name", async () => {
	const meeting = harness();
	await meeting.channel.receive(
		chatMessage("Hey Fabric, what changed?", {
			id: "graph:1700000000000",
			senderName: "Fabric Parlume",
		}),
	);
	await meeting.channel.receive(
		chatMessage("Hey Fabric, what changed?", {
			senderName: "Fabric Parlume",
		}),
	);
	await flush();
	assert.equal(meeting.turns.length, 1);
});

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

test("a post asked for while Parlume speaks goes out once the outlet has sent the speech", async () => {
	const meeting = harness();
	let sentSpeech = () => {};
	meeting.state.speech = new Promise<void>((resolve) => {
		sentSpeech = resolve;
	});

	const answer = meeting.channel.send({ message: "Here is F-12." });
	// The realtime voice's post_to_chat, made after its response is done.
	const voice = meeting.channel.postFromVoice("The link is in Fabric.");
	await flush();
	assert.equal(meeting.posts().length, 0, "held while the speech plays");

	meeting.state.speech = null;
	sentSpeech();
	await answer;
	await voice;

	assert.deepEqual(
		meeting
			.posts()
			.map((r) => String(r.body.message).replace(/^\[P\d+\] /, ""))
			.sort(),
		["Here is F-12.", "The link is in Fabric."],
	);
	assert.deepEqual(
		meeting.events("chat.held_for_speech").map((e) => e.meta.timedOut),
		[false, false],
	);
});

test("a post is never held longer than 30 s, and an essential notice is not held", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const meeting = harness();
	meeting.state.speech = new Promise<void>(() => {});

	const answer = meeting.channel.send({ message: "Here is F-12." });
	await meeting.channel.postNotice("A guest joined.", true);
	await flush();
	assert.deepEqual(
		meeting.posts().map((r) => r.body.message),
		["[P1] A guest joined."],
	);

	t.mock.timers.tick(29_999);
	await flush();
	assert.equal(meeting.posts().length, 1, "still held at 29.999 s");

	t.mock.timers.tick(1);
	await answer;

	assert.equal(meeting.posts().at(-1)?.body.message, "[P2] Here is F-12.");
	assert.equal(
		meeting.events("chat.held_for_speech")[0]?.meta.timedOut,
		true,
	);
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

test("Parlume's own post is saved without the bot's anonymous id; a guest under its name keeps theirs", async () => {
	const meeting = harness();
	await meeting.channel.send({ message: "Here is F-12." });

	await meeting.channel.receive(
		chatMessage("[P1] Here is F-12.", {
			senderName: "Fabric Parlume",
			senderId: "8:teamsvisitor:parlume-bot",
		}),
	);
	await meeting.channel.receive(
		chatMessage("I am Parlume too.", {
			senderName: "Fabric Parlume",
			senderId: "8:teamsvisitor:guest-1",
		}),
	);
	await meeting.channel.receive(
		chatMessage("[P1] Here is F-12.", {
			senderName: "Fabric Parlume",
			senderId: "8:teamsvisitor:guest-1",
		}),
	);

	assert.deepEqual(
		meeting.segments.map((segment) => segment.senderId),
		[null, "8:teamsvisitor:guest-1", "8:teamsvisitor:guest-1"],
	);
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
	assert.deepEqual(meeting.spoken, [], "nothing is said inside the grace");
	assert.equal(
		meeting.wakes.at(-1),
		meeting.clock.now + UNAVAILABLE_GRACE_MS,
		"a check is due when the grace ends",
	);
	await sayUnavailable(meeting);
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

test("a missing post in a chat that works is only unconfirmed, and the meeting hears once that it did not show up", async () => {
	const meeting = harness();
	await meeting.channel.receive(chatMessage("Morning all"));
	await meeting.channel.send({ message: "The link", turnId: "turn-1" });
	meeting.clock.now += 16_000;

	await meeting.channel.checkDeliveries();
	await meeting.channel.checkDeliveries();

	assert.deepEqual(
		meeting.reports().map((r) => r.body.outcome),
		["unconfirmed"],
	);
	assert.equal(meeting.events("chat.unavailable").length, 0);
	assert.deepEqual(meeting.spoken, ["P1 did not show up in the chat."]);
	assert.deepEqual(meeting.events("chat.unseen_announced")[0]?.meta, {
		sessionId: "session-1",
		botId: "bot-1",
		tags: ["P1"],
		spoken: true,
	});
});

// The organizer turned the chat off after it had shown Parlume's posts: the
// voice had said the link was in the chat, and nobody was told it was not.
test("posts for a request, the realtime voice's own included, are said as unseen together; a confirmed one and posts nobody asked for stay silent", async () => {
	const meeting = harness();
	await meeting.channel.receive(chatMessage("Morning all"));
	await meeting.channel.send({ message: "The link", turnId: "turn-1" });
	await meeting.channel.postFromVoice("Open features: F-12 and F-13.");
	await meeting.channel.send({ message: "Shown", turnId: "turn-2" });
	await meeting.channel.send({ message: "Since last time", plain: true });
	await meeting.channel.postNotice("A notice");
	await meeting.channel.receive(
		chatMessage("[P3] Shown", { senderName: "Fabric Parlume" }),
	);
	meeting.clock.now += 15_000;

	await meeting.channel.checkDeliveries();

	assert.deepEqual(
		meeting.reports().map((r) => [r.body.tag, r.body.outcome]),
		[
			["P3", "confirmed"],
			["P1", "unconfirmed"],
			["P2", "unconfirmed"],
			["P4", "unconfirmed"],
			["P5", "unconfirmed"],
		],
	);
	assert.deepEqual(meeting.spoken, ["P1 to P2 did not show up in the chat."]);
});

test("an unseen post waits while Parlume speaks, is retried if it could not be said, and stays silent once the chat shows it late", async () => {
	const meeting = harness();
	await meeting.channel.receive(chatMessage("Morning all"));
	await meeting.channel.send({ message: "The link", turnId: "turn-1" });
	await meeting.channel.send({ message: "The list", turnId: "turn-2" });
	meeting.clock.now += 15_000;
	meeting.state.busy = true;
	await meeting.channel.checkDeliveries();
	assert.deepEqual(meeting.spoken, []);

	await meeting.channel.receive(
		chatMessage("[P1] The link", { senderName: "Fabric Parlume" }),
	);
	meeting.state.busy = false;
	meeting.state.speaks = false;
	await meeting.channel.checkDeliveries();
	meeting.state.speaks = true;
	await meeting.channel.checkDeliveries();
	await meeting.channel.checkDeliveries();

	assert.equal(meeting.events("chat.confirmed")[0]?.meta.late, true);
	assert.deepEqual(meeting.spoken, [
		"P2 did not show up in the chat.",
		"P2 did not show up in the chat.",
	]);
});

test("a requested post the chat shows late, before Parlume could say it was unseen, is never said", async () => {
	const meeting = harness();
	await meeting.channel.receive(chatMessage("Morning all"));
	await meeting.channel.send({ message: "The link", turnId: "turn-1" });
	meeting.clock.now += 15_000;
	meeting.state.busy = true;
	await meeting.channel.checkDeliveries();

	await meeting.channel.receive(
		chatMessage("[P1] The link", { senderName: "Fabric Parlume" }),
	);
	meeting.state.busy = false;
	await meeting.channel.checkDeliveries();

	assert.deepEqual(meeting.spoken, []);
	assert.equal(meeting.events("chat.unseen_announced").length, 0);
});

test("the unavailable notice waits until Parlume is not speaking, and is retried if it could not be said", async () => {
	const meeting = harness();
	await meeting.channel.send({ message: "The link" });
	meeting.clock.now += 15_000;
	await meeting.channel.checkDeliveries();
	meeting.state.busy = true;
	await sayUnavailable(meeting);
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

// The answer, and a proposal's quote of the request, went to the whole chat.
test("a private request to the bot is not answered or kept, and its sender is asked to use the chat", async () => {
	const meeting = harness();
	const message = chatMessage("what is blocking the release?", {
		toBot: true,
	});

	await meeting.channel.receive(message);
	await flush();

	assert.deepEqual(meeting.segments, []);
	assert.deepEqual(plain(meeting.channel.recentMessages()), []);
	assert.deepEqual(meeting.turns, []);
	const posted = meeting.posts().map((post) => String(post.body.message));
	assert.equal(posted.length, 1);
	assert.match(posted[0] ?? "", /only answer in the meeting chat/);
	assert.doesNotMatch(posted[0] ?? "", /blocking the release/);
});

test("a private stop still stops Parlume", async () => {
	const meeting = harness();

	await meeting.channel.receive(chatMessage("stop", { toBot: true }));
	await flush();

	assert.equal(meeting.stops.length, 1);
	assert.deepEqual(meeting.turns, []);
});

test("a message to everyone still goes into the transcript", async () => {
	const meeting = harness();

	await meeting.channel.receive(chatMessage("The demo is at three."));
	await flush();

	assert.equal(meeting.segments.length, 1);
	assert.equal(meeting.segments[0]?.text, "The demo is at three.");
	assert.deepEqual(plain(meeting.channel.recentMessages()), [
		{ from: "Dev One", text: "The demo is at three." },
	]);
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

test("more on a shortened post posts the rest from the stored answer, without asking the agent again", async () => {
	const meeting = harness();
	const line = `${"word ".repeat(39)}end.`;
	const answer = Array.from({ length: 12 }, (_, index) =>
		line.replace("end.", `end ${index}.`),
	).join("\n");
	await meeting.channel.send({ message: answer });

	await meeting.channel.receive(chatMessage("more P1"));
	await flush();

	const [first, second] = meeting.posts().map((r) => String(r.body.message));
	assert.ok(first?.endsWith('Reply "more P1" for the rest.'));
	assert.ok(second?.startsWith("[P2] **Rest of P1**\nword"));
	assert.ok(second?.includes("end 2."));
	assert.ok(!first?.includes("end 2."));
	// A rest longer than one post is shortened again, under its own tag.
	assert.ok(second?.endsWith('Reply "more P2" for the rest.'));
	assert.deepEqual(meeting.turns, []);
	assert.equal(meeting.events("chat.more_rest")[0]?.meta.tag, "P1");
});

test("a turn's post opens with what it is and who asked, and names its turn to Fabric", async () => {
	const meeting = harness();

	await meeting.channel.send({
		message: "F-12 ships Friday.",
		turnId: "turn-1",
		header: {
			kind: "answer",
			asker: "Alex",
			request: "When does F-12 ship?",
		},
	});
	await meeting.channel.send({
		message: "I could not finish the answer. Ask again in a minute.",
		turnId: "turn-2",
		final: true,
		header: { kind: "error", asker: null, request: "What changed?" },
	});

	const [answer, error] = meeting.posts().map((r) => r.body);
	assert.equal(
		answer?.message,
		"[P1] **Answer** for Alex\n*“When does F-12 ship?”*\nF-12 ships Friday.",
	);
	assert.equal(answer?.turnId, "turn-1");
	assert.equal(answer?.turnFailed, undefined);
	assert.equal(
		error?.message,
		"[P2] **Could not answer**\n*“What changed?”*\nI could not finish the answer. Ask again in a minute.",
	);
	assert.equal(error?.turnFailed, true);

	// `say` reads the answer, never its header.
	await meeting.channel.receive(chatMessage("read P1"));
	await flush();
	assert.deepEqual(meeting.spoken, ["F-12 ships Friday."]);
});

test("a typed help posts what can be typed; a bare help is left to people", async () => {
	const meeting = harness();

	await meeting.channel.receive(chatMessage("help"));
	await meeting.channel.receive(chatMessage("Parlume, help"));
	await flush();

	const posts = meeting.posts().map((r) => String(r.body.message));
	assert.equal(posts.length, 1);
	assert.ok(posts[0]?.startsWith("[P1] **What you can type**\n"));
	assert.ok(posts[0]?.includes("more P4 · the rest of P4"));
	assert.deepEqual(meeting.turns, []);
});

test("typed post commands take their spoken forms: read, more on, a closing question mark", async () => {
	const meeting = harness();
	const line = `${"word ".repeat(39)}end.`;
	await meeting.channel.send({
		message: Array.from({ length: 12 }, (_, index) =>
			line.replace("end.", `end ${index}.`),
		).join("\n"),
	});

	await meeting.channel.receive(chatMessage("read P1?"));
	await meeting.channel.receive(chatMessage("more on P1?"));
	await flush();

	assert.equal(meeting.spoken.length, 1);
	const rest = meeting.posts().map((r) => String(r.body.message))[1];
	assert.ok(rest?.startsWith("[P2] **Rest of P1**\n"));
});

test("say, go, more and stop act on tagged posts; an unknown tag is answered, an unaddressed remark ignored", async () => {
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
	// The notice is a post with a tag of its own, like any answer.
	await meeting.channel.send({ message: "F-13 ships Monday." });
	assert.deepEqual(
		meeting.posts().map((post) => post.body.message),
		[
			"[P1] F-12 ships Friday.",
			"[P2] P9: There is no P9 in this meeting's chat. Check the tag on the post you mean.",
			"[P3] F-13 ships Monday.",
		],
	);
});

test("a notice is tagged, gets a delivery record, and takes commands like an answer", async () => {
	const meeting = harness();

	await meeting.channel.receive(chatMessage("go P9"));
	await flush();
	await meeting.channel.receive(
		chatMessage(
			"[P1] P9: There is no P9 in this meeting's chat. Check the tag on the post you mean.",
			{
				senderName: "Fabric Parlume",
			},
		),
	);
	await meeting.channel.receive(chatMessage("say P1"));
	await flush();

	assert.deepEqual(
		meeting.posts().map((post) => post.body.message),
		[
			"[P1] P9: There is no P9 in this meeting's chat. Check the tag on the post you mean.",
		],
	);
	assert.deepEqual(
		meeting
			.reports()
			.map((report) => [
				report.body.tag,
				report.body.kind,
				report.body.outcome,
			]),
		[["P1", "notice", "confirmed"]],
	);
	assert.deepEqual(meeting.spoken, [
		"P9: There is no P9 in this meeting's chat. Check the tag on the post you mean.",
	]);
	assert.deepEqual(meeting.turns, []);
});

// The meeting-chat formatting of answers and results does not apply to the
// recap: Fabric sends it as one paragraph.
test("the recap is sent for its one-paragraph form; an answer is not", async () => {
	const meeting = harness();
	await meeting.channel.send({
		message: "Since last time\n- F-12 shipped.\n- F-13 is blocked.",
		plain: true,
	});
	await meeting.channel.send({ message: "F-14 ships Monday." });

	assert.deepEqual(
		meeting.posts().map((post) => [post.body.message, post.body.plain]),
		[
			["[P1] Since last time\n• F-12 shipped.\n• F-13 is blocked.", true],
			["[P2] F-14 ships Monday.", undefined],
		],
	);
});

// The recap and the join notice were sent at the same time, and the recap
// reached the chat first. Sent a moment after the join notice, a post never
// showed in a live meeting.
test("a recap that comes before the join notice is posted once the chat shows the join notice", async () => {
	const meeting = harness();
	const text = "**Fabric Parlume (AI assistant) is in this meeting**";
	await meeting.channel.expectJoinNotice();

	const response = await meeting.channel.send({
		message: "Since last time: F-12 shipped.",
		plain: true,
	});
	// The chat opened before the notice was posted.
	await meeting.channel.postHeldRecap();

	assert.deepEqual(plain(await response.json()), {
		sent: false,
		reason: "guests_present",
	});
	assert.deepEqual(meeting.posts(), []);

	await meeting.channel.giveJoinNotice({ text, spoken: "Parlume is here." });
	await meeting.channel.postHeldRecap();

	assert.deepEqual(
		meeting.posts().map((post) => post.body.message),
		[`[P1] ${text}`],
		"Fabric took the join notice, but the chat has not shown it",
	);

	await meeting.channel.receive(
		chatMessage(`[P1] ${text}`, { senderName: "Fabric Parlume" }),
	);

	assert.deepEqual(
		meeting.posts().map((post) => post.body.message),
		[`[P1] ${text}`, "[P2] Since last time: F-12 shipped."],
	);
});

// Fabric's request got no tag for a recap the bridge held, and the Parlume
// page said the chat did not take it, though the meeting showed it.
test("a recap, held or not, tells Fabric it is the recap, so the page records its tag", async () => {
	const meeting = harness();
	const text = "**Fabric Parlume (AI assistant) is in this meeting**";
	await meeting.channel.expectJoinNotice();
	await meeting.channel.send({
		message: "Since last time: F-12 shipped.",
		plain: true,
	});
	await meeting.channel.giveJoinNotice({ text, spoken: "Parlume is here." });
	await meeting.channel.receive(
		chatMessage(`[P1] ${text}`, { senderName: "Fabric Parlume" }),
	);
	await meeting.channel.send({
		message: "Since last time: F-13 shipped.",
		plain: true,
	});
	await meeting.channel.send({ message: "F-14 ships Monday." });

	assert.deepEqual(
		meeting.posts().map((post) => [post.body.message, post.body.recap]),
		[
			[`[P1] ${text}`, undefined],
			["[P2] Since last time: F-12 shipped.", true],
			["[P3] Since last time: F-13 shipped.", true],
			["[P4] F-14 ships Monday.", undefined],
		],
	);
});

test("a held recap follows a join notice that went unconfirmed in a chat that shows other messages", async () => {
	const meeting = harness();
	const text = "**Fabric Parlume (AI assistant) is in this meeting**";
	const recap = "Since last time: F-12 shipped.";
	await meeting.channel.expectJoinNotice();
	await meeting.channel.send({ message: recap, plain: true });
	await meeting.channel.giveJoinNotice({ text, spoken: "Parlume is here." });
	await meeting.channel.receive(chatMessage("Morning, all"));
	await flush();
	assert.deepEqual(
		meeting.posts().map((post) => post.body.message),
		[`[P1] ${text}`],
	);

	meeting.clock.now += 15_000;
	await meeting.channel.checkDeliveries();

	assert.deepEqual(
		meeting.posts().map((post) => post.body.message),
		[`[P1] ${text}`, `[P2] ${recap}`],
	);
});

test("a recap that comes after the chat shows the join notice is posted at once", async () => {
	const meeting = harness();
	const text = "**Fabric Parlume (AI assistant) is in this meeting**";
	await meeting.channel.expectJoinNotice();
	await meeting.channel.giveJoinNotice({ text, spoken: "Parlume is here." });
	await meeting.channel.receive(
		chatMessage(`[P1] ${text}`, { senderName: "Fabric Parlume" }),
	);

	const response = await meeting.channel.send({
		message: "Since last time: F-12 shipped.",
		plain: true,
	});

	assert.deepEqual(plain(await response.json()), {
		sent: true,
		tag: "P2",
		delivery: "queued",
	});
});

const CONFIRM_URL =
	"https://fabric.example.com/app/example-org/projects/project-1/parlume/actions/action-1";
const DISMISS_URL = `${CONFIRM_URL}?intent=dismiss`;
const PROPOSAL_SPOKEN =
	"Proposed change, not made yet: Create feature “Export to CSV”. A signed-in project member can confirm it in Fabric.";
const PROPOSAL_MESSAGE = [
	"**Proposed change** · not made yet",
	"Create feature “Export to CSV” in Example Project",
	"Asked by Alex: “create a feature called Export to CSV”",
	"Priority: High",
	`[Confirm in Fabric](${CONFIRM_URL}) · [Dismiss](${DISMISS_URL})`,
	"Only a signed-in project member can confirm. Open for 24 hours.",
].join("\n");

function sendProposal(
	meeting: ReturnType<typeof harness>,
	proposal: Record<string, unknown> = {},
) {
	return meeting.channel.send({
		message: PROPOSAL_MESSAGE,
		turnId: "turn-1",
		proposal: {
			actionId: "action-1",
			spoken: PROPOSAL_SPOKEN,
			confirmUrl: CONFIRM_URL,
			dismissUrl: DISMISS_URL,
			...proposal,
		},
	});
}

test("a proposal is posted tag first with its Confirm and Dismiss links, bold kept, under 1,500 characters", async () => {
	const meeting = harness();

	const sent = plain(await (await sendProposal(meeting)).json());

	assert.deepEqual(sent, { sent: true, tag: "P1", delivery: "queued" });
	const message = String(meeting.posts()[0]?.body.message);
	assert.equal(message, `[P1] ${PROPOSAL_MESSAGE}`);
	assert.ok(message.startsWith("[P1] **Proposed change**"));
	assert.ok(message.includes(`[Confirm in Fabric](${CONFIRM_URL})`));
	assert.ok(message.includes(`[Dismiss](${DISMISS_URL})`));
	assert.ok(message.length < 1_500);
	assert.equal(meeting.turns.length, 0);
});

test("go P8 or more on a proposal posts its Confirm link and starts no turn; say reads the proposal", async () => {
	const meeting = harness();
	await meeting.channel.startTagsAt(8);
	await sendProposal(meeting);

	await meeting.channel.receive(chatMessage("go P8"));
	await meeting.channel.receive(chatMessage("more P8"));
	await meeting.channel.receive(chatMessage("say P8"));
	await flush();

	const link = `P8 is a proposed change. A signed-in member confirms it in Fabric: [Confirm P8 in Fabric](${CONFIRM_URL})`;
	assert.deepEqual(
		meeting.posts().map((post) => post.body.message),
		[`[P8] ${PROPOSAL_MESSAGE}`, `[P9] ${link}`, `[P10] ${link}`],
	);
	assert.deepEqual(meeting.turns, []);
	assert.deepEqual(meeting.spoken, [PROPOSAL_SPOKEN]);
	assert.equal(meeting.events("chat.proposal_link").length, 2);
});

test("a spoken go on a proposal posts the Confirm link, says one sentence pointing to it, and starts no turn", async () => {
	const meeting = harness();
	await meeting.channel.startTagsAt(8);
	await sendProposal(meeting);

	const action = plain(
		await meeting.channel.spokenReference({ kind: "go", tag: "P8" }),
	);

	assert.deepEqual(action, {
		kind: "speak",
		text: "I posted the link to confirm P8 in the chat; a signed-in project member confirms it in Fabric.",
	});
	assert.equal(
		meeting.posts()[1]?.body.message,
		`[P9] P8 is a proposed change. A signed-in member confirms it in Fabric: [Confirm P8 in Fabric](${CONFIRM_URL})`,
	);
	assert.deepEqual(meeting.turns, []);
	assert.deepEqual(meeting.spoken, []);
});

test("a spoken go on a proposal points to the Parlume page when the link cannot be posted", async () => {
	const meeting = harness({
		fabric: (path) =>
			path.endsWith("/chat") && meeting.posts().length > 1
				? new Response(null, { status: 503 })
				: Response.json({ accepted: true }),
	});
	await sendProposal(meeting);

	const action = plain(
		await meeting.channel.spokenReference({ kind: "go", tag: "P1" }),
	);

	assert.deepEqual(action, {
		kind: "speak",
		text: "P1 waits on the Parlume page in Fabric, where a signed-in project member can confirm it.",
	});
	assert.deepEqual(meeting.turns, []);
});

test("a proposal without an action, a spoken form or web links is refused, and the held post kind no longer exists", async () => {
	for (const proposal of [
		{ actionId: "" },
		{ spoken: " " },
		{ confirmUrl: "javascript:alert(1)" },
		{ dismissUrl: "not a link" },
	]) {
		const meeting = harness();
		const response = await sendProposal(meeting, proposal);
		assert.equal(response.status, 400);
		assert.equal(meeting.posts().length, 0);
	}
	const meeting = harness();
	const held = await meeting.channel.send({
		held: {
			action: "create the work item “Export”",
			request: "create a work item called Export",
		},
	});
	assert.equal(held.status, 400);
	assert.equal(meeting.posts().length, 0);
});

test("a spoken reference gets the same post action for the caller to answer by voice", async () => {
	const meeting = harness();
	await meeting.channel.send({
		message: "Two open features: F-12 and F-13.",
	});
	await sendProposal(meeting);

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
		plain(
			await meeting.channel.spokenReference({ kind: "say", tag: "P2" }),
		),
		{ kind: "speak", text: PROPOSAL_SPOKEN },
	);
	assert.deepEqual(
		plain(
			await meeting.channel.spokenReference({ kind: "say", tag: "P9" }),
		),
		{
			kind: "speak",
			text: "P9: There is no P9 in this meeting's chat. Check the tag on the post you mean.",
		},
	);
	assert.deepEqual(meeting.turns, []);
	assert.deepEqual(meeting.spoken, []);
});

test("a session that continues the meeting's numbering answers an earlier session's tag with a notice, typed or spoken", async () => {
	const meeting = harness();
	await meeting.channel.startTagsAt(5);
	await meeting.channel.send({ message: "F-12 ships Friday." });
	// Only a session that has posted nothing yet starts later.
	await meeting.channel.startTagsAt(9);
	await meeting.channel.send({ message: "F-13 ships Monday." });

	await meeting.channel.receive(chatMessage("go P1"));
	await meeting.channel.receive(chatMessage("more P4"));
	await meeting.channel.receive(chatMessage("say P5"));
	await flush();

	assert.deepEqual(
		meeting.posts().map((post) => post.body.message),
		[
			"[P5] F-12 ships Friday.",
			"[P6] F-13 ships Monday.",
			"[P7] P1: This meeting has ended for the Parlume session that posted it, so it can no longer be played.",
			"[P8] P4: This meeting has ended for the Parlume session that posted it, so it can no longer be played.",
		],
	);
	assert.deepEqual(meeting.spoken, ["F-12 ships Friday."]);
	assert.deepEqual(meeting.turns, []);
	assert.deepEqual(
		meeting
			.events("chat.command_unknown_post")
			.map((entry) => entry.meta.earlierSession),
		[true, true],
	);
	assert.deepEqual(
		plain(await meeting.channel.spokenReference({ kind: "go", tag: "P2" })),
		{
			kind: "speak",
			text: "P2: This meeting has ended for the Parlume session that posted it, so it can no longer be played.",
		},
	);
	assert.deepEqual(
		plain(await meeting.channel.spokenReference({ kind: "go", tag: "P9" })),
		{
			kind: "speak",
			text: "P9: There is no P9 in this meeting's chat. Check the tag on the post you mean.",
		},
	);
});

test("every post stays playable for the whole session, past the fifty whose delivery is tracked", async () => {
	const meeting = harness();
	for (let index = 1; index <= 60; index++) {
		await meeting.channel.send({ message: `Answer ${index}.` });
	}

	await meeting.channel.receive(chatMessage("go P3"));
	await flush();
	await flush();

	assert.deepEqual(meeting.spoken, ["Answer 3."]);
	assert.deepEqual(meeting.events("chat.command_unknown_post"), []);
	assert.deepEqual(
		plain(await meeting.channel.spokenReference({ kind: "go", tag: "P2" })),
		{ kind: "speak", text: "Answer 2." },
	);
	assert.equal(meeting.data.has("chatPost:P1"), true);
	assert.equal(meeting.data.has("chatPost:P60"), true);
});

test("the latest go wins when an older post is read from storage first", async () => {
	const meeting = harness();
	for (let index = 1; index <= 55; index++) {
		await meeting.channel.send({ message: `Answer ${index}.` });
	}

	await meeting.channel.receive(chatMessage("go P1"));
	await meeting.channel.receive(chatMessage("go P55"));
	await flush();
	await flush();

	assert.deepEqual(meeting.spoken, ["Answer 1.", "Answer 55."]);
});

test("as Parlume leaves, the meeting is told once that the posts it offered can no longer be played", async () => {
	const meeting = harness();
	await meeting.channel.postNotice("Notes only.");
	await meeting.channel.send({ message: "F-12 ships Friday." });
	await meeting.channel.send({ message: "F-13 ships Monday." });
	// The line is posted even while a guest is in.
	meeting.guests.present = true;

	const first = await meeting.channel.leaving();
	const second = await meeting.channel.leaving();

	assert.deepEqual(await first.json(), { posted: true });
	assert.deepEqual(await second.json(), { posted: false });
	assert.deepEqual(
		meeting.posts().map((post) => post.body.message),
		[
			"[P1] Notes only.",
			"[P2] F-12 ships Friday.",
			"[P3] F-13 ships Monday.",
			"[P4] Unavailable: P2 to P3. This meeting has ended for Parlume, so these posts can no longer be played.",
		],
	);
});

test("a session that offered nothing posts no line as it leaves", async () => {
	const meeting = harness();
	await meeting.channel.postNotice("Notes only.");

	const left = await meeting.channel.leaving();

	assert.deepEqual(await left.json(), { posted: false });
	assert.deepEqual(
		meeting.posts().map((post) => post.body.message),
		["[P1] Notes only."],
	);
});

// The alarm gives the join notice and checks deliveries at the same time:
// the second first read of the chat state replaced the one the notice was
// recorded on, and the check's settle stood in for the notice's.
test("a join notice given while deliveries are checked is posted and kept", async () => {
	const meeting = harness();
	const text = "**Fabric Parlume (AI assistant) is in this meeting**";

	await Promise.all([
		meeting.channel.giveJoinNotice({ text, spoken: "Parlume is here." }),
		meeting.channel.checkDeliveries(),
	]);
	await flush();

	assert.deepEqual(
		meeting.posts().map((post) => post.body.message),
		[`[P1] ${text}`],
	);
	const stored = meeting.data.get("chat") as {
		joinNotice?: { tag: string | null };
	};
	assert.equal(stored.joinNotice?.tag, "P1");
});

// A segment's wake check read the suggestion state for the first time while
// a pass did, and replaced the state the pass had recorded itself on: the
// next pass ran at once instead of after the interval.
test("a suggestion pass run while a wake is checked is remembered, so the next waits its interval", async () => {
	const meeting = harness();
	for (let index = 0; index < 3; index++) {
		meeting.channel.noteSpeechSegment();
	}

	await Promise.all([
		meeting.channel.runSuggestionPass({
			enabled: true,
			audience: "MEETING",
		}),
		meeting.channel.nextWakeAt({ suggestions: true, audience: "MEETING" }),
	]);
	await passAfter(meeting, 1_000);

	assert.equal(
		meeting.requests.filter((r) => r.path.endsWith("/suggest")).length,
		1,
	);
	const stored = meeting.data.get("chatSuggestions") as {
		lastPassAt: number;
	};
	assert.equal(stored.lastPassAt, 1_000_000);
});

const ENDED_LINE =
	"This meeting has ended for Parlume, so these posts can no longer be played.";

test("the leaving line names a proposed change apart, not as a post that can no longer be played", async () => {
	const meeting = harness();
	await meeting.channel.send({ message: "F-12 ships Friday." });
	await sendProposal(meeting);
	await meeting.channel.send({ message: "Done: Create bug 12." });

	await meeting.channel.leaving();

	assert.equal(
		meeting.posts().at(-1)?.body.message,
		`[P4] Unavailable: P1, P3. ${ENDED_LINE} The proposed change P2 stays on its page in Fabric.`,
	);
});

test("the leaving line names only offers Fabric took to send, not notices or refused posts", async () => {
	const meeting = harness({
		fabric: (path, body) =>
			path.endsWith("/chat") && String(body.message).includes("Refused")
				? new Response(null, { status: 502 })
				: Response.json({ accepted: true }),
	});
	await meeting.channel.send({ message: "F-12 ships Friday." });
	await meeting.channel.send({ message: "Refused." });
	await meeting.channel.postNotice("Notes only.");
	await meeting.channel.send({ message: "F-13 ships Monday." });

	await meeting.channel.leaving();

	assert.equal(
		meeting.posts().at(-1)?.body.message,
		`[P5] Unavailable: P1, P4. ${ENDED_LINE}`,
	);
});

// The line once counted as given before it was sent: a failed post was never
// tried again.
test("a leaving line Fabric refused is posted by a later leaving call", async () => {
	let refuse = true;
	const meeting = harness({
		fabric: (path, body) =>
			path.endsWith("/chat") &&
			refuse &&
			String(body.message).includes("Unavailable")
				? new Response(null, { status: 502 })
				: Response.json({ accepted: true }),
	});
	await meeting.channel.send({ message: "F-12 ships Friday." });

	assert.deepEqual(await (await meeting.channel.leaving()).json(), {
		posted: false,
	});
	refuse = false;
	assert.deepEqual(await (await meeting.channel.leaving()).json(), {
		posted: true,
	});
	assert.deepEqual(await (await meeting.channel.leaving()).json(), {
		posted: false,
	});
	assert.deepEqual(
		meeting.posts().map((post) => post.body.message),
		[
			"[P1] F-12 ships Friday.",
			`[P2] Unavailable: P1. ${ENDED_LINE}`,
			`[P3] Unavailable: P1. ${ENDED_LINE}`,
		],
	);
});

test("leaving calls at the same time post one line", async () => {
	const meeting = harness();
	await meeting.channel.send({ message: "F-12 ships Friday." });

	const left = await Promise.all([
		meeting.channel.leaving(),
		meeting.channel.leaving(),
	]);

	assert.deepEqual(
		await Promise.all(left.map((response) => response.json())),
		[{ posted: true }, { posted: true }],
	);
	assert.equal(meeting.posts().length, 2);
});

// A call with a notice shared the answer of a call without one already
// under way, and the notice was never posted. The reason comes first.
test("a leaving call with a notice, made while one without is under way, still posts its notice before the line", async () => {
	const meeting = harness();
	await meeting.channel.send({ message: "F-12 ships Friday." });

	const [withoutNotice, withNotice] = await Promise.all([
		meeting.channel.leaving(),
		meeting.channel.leaving({ notice: "I'm leaving: example." }),
	]);

	assert.deepEqual(await withoutNotice.json(), { posted: true });
	assert.deepEqual(await withNotice.json(), {
		posted: false,
		noticed: true,
	});
	assert.deepEqual(
		meeting.posts().map((post) => post.body.message),
		[
			"[P1] F-12 ships Friday.",
			"[P2] I'm leaving: example.",
			`[P3] Unavailable: P1. ${ENDED_LINE}`,
		],
	);
});

test("a leaving call with no bot in the meeting stores nothing", async () => {
	const meeting = harness({ noBot: true });

	assert.deepEqual(await (await meeting.channel.leaving()).json(), {
		posted: false,
	});
	assert.equal(meeting.data.has("chat"), false);
});

// A notice the bridge could not post was answered like one it did, and
// Fabric never recorded that the meeting was not told why Parlume left.
test("a leaving call says whether the meeting got its notice", async () => {
	let refuse = true;
	const meeting = harness({
		fabric: (path) =>
			path.endsWith("/chat") && refuse
				? new Response(null, { status: 502 })
				: Response.json({ accepted: true }),
	});
	const notice = { notice: "I'm leaving: example." };

	assert.deepEqual(await (await meeting.channel.leaving(notice)).json(), {
		posted: false,
		noticed: false,
	});
	refuse = false;
	assert.deepEqual(await (await meeting.channel.leaving(notice)).json(), {
		posted: false,
		noticed: true,
	});
	assert.deepEqual(
		await (await harness({ noBot: true }).channel.leaving(notice)).json(),
		{ posted: false, noticed: false },
	);
});

test("a post Fabric refused is not kept, and offers nothing to end", async () => {
	const meeting = harness({
		fabric: (path) =>
			path.endsWith("/chat")
				? new Response(null, { status: 502 })
				: Response.json({ accepted: true }),
	});
	await meeting.channel.send({ message: "F-12 ships Friday." });

	assert.equal(meeting.data.has("chatPost:P1"), false);
	assert.deepEqual(await (await meeting.channel.leaving()).json(), {
		posted: false,
	});
	assert.equal(meeting.posts().length, 1);
});

const UNCONFIRMED_ERROR =
	"Channel chat delivery could not be confirmed. Check the meeting thread before retrying.";

// Fabric's channel send can fail after Graph created the reply: the post is
// in the thread, so its answer must still play and the leaving line name it.
test("a post Fabric could not confirm after the chat may have got it stays playable, and the leaving line names it", async () => {
	const meeting = harness({
		fabric: (path, body) =>
			path.endsWith("/chat") && body.message === "[P1] F-12 ships Friday."
				? Response.json(
						{ error: UNCONFIRMED_ERROR, outcome: "unknown" },
						{ status: 502 },
					)
				: Response.json({ accepted: true }),
	});

	const sent = plain(
		await (
			await meeting.channel.send({ message: "F-12 ships Friday." })
		).json(),
	);
	await meeting.channel.receive(chatMessage("go P1"));
	await flush();
	await flush();
	await meeting.channel.leaving();

	assert.deepEqual(sent, { sent: true, tag: "P1", delivery: "unknown" });
	assert.equal(meeting.data.has("chatPost:P1"), true);
	assert.deepEqual(meeting.events("chat.forwarded")[0]?.meta, {
		sessionId: "session-1",
		botId: "bot-1",
		tag: "P1",
		kind: "reply",
		chars: "[P1] F-12 ships Friday.".length,
		sent: true,
		delivery: "unknown",
	});
	// Its delivery is still checked, as for a post Fabric took.
	assert.equal(meeting.wakes[0], 1_015_000);
	assert.deepEqual(meeting.spoken, ["F-12 ships Friday."]);
	assert.equal(
		meeting.posts().at(-1)?.body.message,
		`[P2] Unavailable: P1. ${ENDED_LINE}`,
	);
});

test("a post Fabric says it did not send is still forgotten, and go on it plays nothing", async () => {
	const meeting = harness({
		fabric: (path, body) =>
			path.endsWith("/chat") && body.message === "[P1] F-12 ships Friday."
				? Response.json(
						{ error: UNCONFIRMED_ERROR, outcome: "not_sent" },
						{ status: 502 },
					)
				: Response.json({ accepted: true }),
	});

	const sent = plain(
		await (
			await meeting.channel.send({ message: "F-12 ships Friday." })
		).json(),
	);
	await meeting.channel.receive(chatMessage("go P1"));
	await flush();
	await flush();

	assert.deepEqual(sent, { sent: false, reason: "failed" });
	assert.equal(meeting.data.has("chatPost:P1"), false);
	assert.equal(meeting.events("chat.forwarded")[0]?.meta.delivery, null);
	assert.deepEqual(meeting.spoken, []);
	assert.deepEqual(await (await meeting.channel.leaving()).json(), {
		posted: false,
	});
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
	await meeting.channel.runSuggestionPass({
		enabled: true,
		audience: "MEETING",
	});
	assert.equal(suggests().length, 0, "one remark is not enough");

	// The first pass runs as soon as enough is said, with no interval to wait.
	meeting.channel.noteSpeechSegment();
	await meeting.channel.runSuggestionPass({
		enabled: true,
		audience: "MEETING",
	});

	assert.deepEqual(suggests()[0]?.body, {
		sessionId: "session-1",
		botId: "bot-1",
		previous: [],
		teamAudience: true,
	});
	assert.equal(
		meeting.posts()[0]?.body.message,
		'[P1] Suggestion on Roadmap export, re Sam: "we still need an export". F-12 already covers this. (reply "go P1" and I\'ll say it)',
	);
	assert.deepEqual(records(meeting)[0]?.body, {
		sessionId: "session-1",
		botId: "bot-1",
		kind: "answer",
		text: "F-12 already covers this.",
		speaker: "Sam",
		quote: "we still need an export",
		topic: "Roadmap export",
		chatTag: "P1",
	});
	await meeting.channel.receive(chatMessage("go P1"));
	await flush();
	assert.deepEqual(meeting.spoken, [
		"Sam, on Roadmap export: F-12 already covers this.",
	]);

	// The counter starts again: no pass until two more segments.
	meeting.clock.now += 45_000;
	await meeting.channel.runSuggestionPass({
		enabled: true,
		audience: "MEETING",
	});
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
		await meeting.channel.runSuggestionPass({
			enabled,
			audience: "MEETING",
		});
	};
	await meeting.channel.receive(chatMessage("Morning"));
	await meeting.channel.runSuggestionPass({
		enabled: true,
		audience: "MEETING",
	});

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

	await meeting.channel.runSuggestionPass({
		enabled: true,
		audience: "MEETING",
	});

	assert.equal(
		meeting.requests.filter((r) => r.path.endsWith("/suggest")).length,
		0,
	);
});

test("a team-only suggestion is recorded for the Parlume page and never posted in the chat", async () => {
	const meeting = suggesting({ kind: "missed_question", audience: "TEAM" });
	await meeting.channel.receive(chatMessage("Morning"));

	await passAfter(meeting, 0, "TEAM");

	assert.equal(meeting.posts().length, 0);
	assert.deepEqual(records(meeting)[0]?.body, {
		sessionId: "session-1",
		botId: "bot-1",
		kind: "missed_question",
		text: "Who signs off the migration?",
		speaker: "Alex",
		quote: "we move the data in March",
		topic: "Data migration",
		chatTag: null,
	});
	assert.equal(meeting.events("suggestion.pass")[0]?.meta.audience, "TEAM");
});

// TEAM wins whichever side says it: the session as verified, or the pass.
for (const [verified, answered] of [
	["TEAM", "MEETING"],
	["MEETING", "TEAM"],
	["TEAM", undefined],
] as const) {
	test(`a suggestion is kept off the chat when verified ${verified} and answered ${answered ?? "(none)"}`, async () => {
		const meeting = suggesting(
			answered === undefined ? {} : { audience: answered },
		);
		await meeting.channel.receive(chatMessage("Morning"));

		await passAfter(meeting, 0, verified);

		assert.equal(meeting.posts().length, 0);
		assert.equal(records(meeting).length, 1);
		assert.equal(records(meeting)[0]?.body.chatTag, null);
	});
}

test("a meeting suggestion is posted, then recorded with its tag; a missed question asks to be asked", async () => {
	const meeting = suggesting({
		kind: "missed_question",
		audience: "MEETING",
	});
	await meeting.channel.receive(chatMessage("Morning"));

	await passAfter(meeting, 0);

	assert.equal(
		meeting.posts()[0]?.body.message,
		'[P1] Possibly missed question on Data migration, re Alex: "we move the data in March". Who signs off the migration? (reply "go P1" and I\'ll ask it)',
	);
	// A suggestion keeps its one paragraph: Fabric does not format it.
	assert.equal(meeting.posts()[0]?.body.plain, true);
	assert.equal(records(meeting)[0]?.body.chatTag, "P1");
	// Fabric takes the audience from the session, not from the bridge.
	assert.equal(records(meeting)[0]?.body.audience, undefined);
	await meeting.channel.receive(chatMessage("go P1"));
	await flush();
	assert.deepEqual(meeting.spoken, [
		"A question we may not have covered on Data migration: Who signs off the migration?",
	]);
});

test("team-only suggestions count toward the same limits and duplicates", async () => {
	const meeting = suggesting({ audience: "TEAM" });
	await meeting.channel.receive(chatMessage("Morning"));

	await passAfter(meeting, 0, "TEAM");
	await passAfter(meeting, 60_000, "TEAM");
	assert.equal(records(meeting).length, 1, "within two minutes of the last");

	await passAfter(meeting, 120_000, "TEAM");
	assert.equal(records(meeting).length, 1, "the same suggestion again");
	assert.equal(
		meeting.events("suggestion.pass").at(-1)?.meta.duplicate,
		true,
	);
});

test("a failed record leaves the meeting chat as it was", async () => {
	const meeting = harness({
		fabric: (path) =>
			path.endsWith("/suggest")
				? Response.json({
						suggest: true,
						kind: "answer",
						audience: "MEETING",
						text: "F-12 already covers this.",
						speaker: "Sam",
						quote: "we still need an export",
						topic: "Roadmap export",
					})
				: path.endsWith("/suggestions")
					? new Response(null, { status: 500 })
					: Response.json({ accepted: true }),
	});
	await meeting.channel.receive(chatMessage("Morning"));

	await passAfter(meeting, 0);

	assert.equal(meeting.posts().length, 1);
	assert.equal(meeting.events("suggestion.record_failed").length, 1);
});

test("a suggestion for an audience the bridge does not know is neither posted nor recorded", async () => {
	const meeting = suggesting({ audience: "EVERYONE" });
	await meeting.channel.receive(chatMessage("Morning"));

	await passAfter(meeting, 0, "TEAM");

	assert.equal(meeting.posts().length, 0);
	assert.equal(records(meeting).length, 0);
});

// The audience comes from the verified stream, so it holds before the first
// pass and whatever a pass answers.
test("a team-only session suggests even when the chat went unavailable before its first pass", async () => {
	const meeting = suggesting({ audience: "TEAM" });
	await loseChat(meeting);
	for (let index = 0; index < 3; index++) {
		meeting.channel.noteSpeechSegment();
	}
	assert.notEqual(
		await meeting.channel.nextWakeAt({
			suggestions: true,
			audience: "TEAM",
		}),
		null,
		"a pass is scheduled",
	);

	await passAfter(meeting, 0, "TEAM");

	assert.equal(suggestPasses(meeting), 1);
	assert.equal(records(meeting).length, 1);
});

test("a meeting session runs no pass while its chat is unavailable", async () => {
	const meeting = suggesting({ audience: "MEETING" });
	await loseChat(meeting);

	await passAfter(meeting, 0, "MEETING");

	assert.equal(suggestPasses(meeting), 0);
});

test("an answer with no audience does not stop a team-only session's later passes", async () => {
	let answer: Record<string, unknown> = { suggest: false };
	const meeting = harness({
		fabric: (path) =>
			path.endsWith("/suggest")
				? Response.json(answer)
				: Response.json({ accepted: true }),
	});
	await loseChat(meeting);

	await passAfter(meeting, 0, "TEAM");
	answer = {
		suggest: true,
		audience: "TEAM",
		text: "Who signs off the migration?",
		speaker: "Alex",
		quote: "we move the data in March",
		topic: "Data migration",
	};
	await passAfter(meeting, 60_000, "TEAM");

	assert.equal(suggestPasses(meeting), 2);
	assert.equal(records(meeting).length, 1);
	assert.equal(records(meeting)[0]?.body.chatTag, null);
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
	await meeting.channel.runSuggestionPass({
		enabled: true,
		audience: "MEETING",
	});
	const passEvery = async (ms: number, passes: number) => {
		for (let pass = 0; pass < passes; pass++) {
			for (let segment = 0; segment < 3; segment++) {
				meeting.channel.noteSpeechSegment();
			}
			meeting.clock.now += ms;
			await meeting.channel.runSuggestionPass({
				enabled: true,
				audience: "MEETING",
			});
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

// A proposal answered the request; the turn's "P2 waits for a member" reply
// was a second post saying the same.
test("a close ends a chat request without a post, and only as the final", async () => {
	const meeting = harness();
	meeting.channel.beginChatTurn(4);

	const refused = await meeting.channel.send({
		message: "",
		voiceGeneration: 4,
		close: true,
	});
	assert.equal(refused.status, 400);
	assert.equal(meeting.channel.isChatTurnCurrent(4), true);

	const closed = await meeting.channel.send({
		message: "",
		turnId: "turn-1",
		voiceGeneration: 4,
		final: true,
		close: true,
	});
	assert.deepEqual(plain(await closed.json()), { closed: true });
	assert.equal(meeting.channel.isChatTurnCurrent(4), false);
	assert.equal(meeting.posts().length, 0);
});

test("the next wake is the earliest future delivery deadline or suggestion pass", async () => {
	const meeting = harness();
	const wake = (suggestions = true) =>
		meeting.channel.nextWakeAt({ suggestions, audience: "MEETING" });
	assert.equal(await wake(), null, "nothing said: no pass to wake for");

	assert.equal(meeting.channel.noteSpeechSegment(), false);
	assert.equal(meeting.channel.noteSpeechSegment(), true, "enough said");
	assert.equal(meeting.channel.noteSpeechSegment(), false);
	assert.equal(await wake(), 1_005_000, "the first pass: right away");
	assert.equal(await wake(false), null, "suggestions off");

	meeting.state.busy = true;
	await meeting.channel.runSuggestionPass({
		enabled: true,
		audience: "MEETING",
	});
	meeting.clock.now += 60_000;
	assert.equal(
		await wake(),
		1_065_000,
		"due but busy: shortly, not in a tight loop",
	);
	meeting.state.busy = false;
	await meeting.channel.runSuggestionPass({
		enabled: true,
		audience: "MEETING",
	});
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
	await meeting.channel.runSuggestionPass({
		enabled: true,
		audience: "MEETING",
	});
	meeting.channel.noteSpeechSegment();
	meeting.channel.noteSpeechSegment();
	meeting.clock.now += 45_000;
	await meeting.channel.runSuggestionPass({
		enabled: true,
		audience: "MEETING",
	});
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
		await meeting.channel.nextWakeAt({
			suggestions: true,
			audience: "MEETING",
		}),
		postedAt + 120_000,
	);
});

const NOTICE = {
	text: [
		"**Fabric Parlume (AI assistant) is in this meeting**",
		"I transcribe the meeting and write notes. I keep transcripts for 90 days, and notes until someone deletes them.",
		'To pause me, say or type "Parlume, pause". [Parlume page](https://fabric.example/app/example-org/projects/p1/parlume)',
	].join("\n"),
	spoken: "Fabric Parlume, an AI assistant, is in this meeting.",
};

const joinNoticeReports = (meeting: ReturnType<typeof harness>) =>
	meeting.requests
		.filter((r) => r.path.endsWith("/join-notice"))
		.map((r) => r.body);

test("the join notice is posted once, and Fabric records when it shows up in the chat", async () => {
	const meeting = harness();

	await meeting.channel.giveJoinNotice(NOTICE);
	await meeting.channel.giveJoinNotice(NOTICE);
	await meeting.channel.receive(
		chatMessage(`[P1] ${NOTICE.text}`, { senderName: "Fabric Parlume" }),
	);

	assert.deepEqual(
		meeting.posts().map((post) => post.body.message),
		[`[P1] ${NOTICE.text}`],
	);
	assert.deepEqual(joinNoticeReports(meeting), [
		{ sessionId: "session-1", botId: "bot-1", via: "chat", tag: "P1" },
	]);
});

// The chat showed the join notice before Fabric answered, and that answer
// then failed: the recap waited for an answer that never came.
test("a held recap follows a join notice the chat showed, even when Fabric's answer to it failed", async () => {
	let answer: (response: Response) => void = () => {};
	const meeting = harness({
		fabric: (path, body) =>
			path.endsWith("/chat") &&
			String(body.message).startsWith("[P1] **Fabric Parlume")
				? new Promise<Response>((resolve) => {
						answer = resolve;
					})
				: Response.json({ accepted: true }),
	});
	const recap = "Since last time: F-12 shipped.";
	await meeting.channel.expectJoinNotice();
	await meeting.channel.send({ message: recap, plain: true });

	const giving = meeting.channel.giveJoinNotice(NOTICE);
	await flush();
	const shown = meeting.channel.receive(
		chatMessage(`[P1] ${NOTICE.text}`, { senderName: "Fabric Parlume" }),
	);
	await flush();
	answer(new Response(null, { status: 502 }));
	await giving;
	await shown;
	await flush();

	assert.equal(
		meeting
			.posts()
			.some((post) => String(post.body.message).endsWith(recap)),
		true,
	);
});

const heldRecap = (meeting: ReturnType<typeof harness>) =>
	(meeting.data.get("chat") as { heldRecap?: string }).heldRecap;

// Fabric could not take the join notice, the chat turned out to be out of
// reach, and the notice was said aloud: the recap waited for good.
test("a held recap follows a join notice said aloud, once the chat shows a message again", async () => {
	const recap = "Since last time: F-12 shipped.";
	const meeting = harness({
		fabric: (path, body) =>
			path.endsWith("/chat") &&
			String(body.message).includes("**Fabric Parlume")
				? new Response(null, { status: 503 })
				: Response.json({ accepted: true }),
	});
	await meeting.channel.expectJoinNotice();
	await meeting.channel.send({ message: recap, plain: true });
	await meeting.channel.giveJoinNotice(NOTICE);
	await loseChat(meeting);

	assert.deepEqual(meeting.spoken, [NOTICE.spoken]);
	assert.equal(
		meeting
			.posts()
			.some((post) => String(post.body.message).endsWith(recap)),
		false,
	);
	assert.equal(heldRecap(meeting), recap, "the recap waits for the chat");

	await meeting.channel.receive(chatMessage("Morning, all"));
	await flush();

	assert.equal(meeting.posts().at(-1)?.body.message, `[P3] ${recap}`);
	assert.equal(heldRecap(meeting), undefined);
});

test("a held recap Fabric could not take waits again, and is posted on the next delivery check", async () => {
	let refuse = true;
	const recap = "Since last time: F-12 shipped.";
	const meeting = harness({
		fabric: (path, body) =>
			refuse &&
			path.endsWith("/chat") &&
			String(body.message).endsWith(recap)
				? new Response(null, { status: 503 })
				: Response.json({ accepted: true }),
	});
	await meeting.channel.expectJoinNotice();
	await meeting.channel.send({ message: recap, plain: true });
	await meeting.channel.giveJoinNotice(NOTICE);
	await meeting.channel.receive(
		chatMessage(`[P1] ${NOTICE.text}`, { senderName: "Fabric Parlume" }),
	);

	assert.equal(heldRecap(meeting), recap);

	refuse = false;
	await meeting.channel.checkDeliveries();

	assert.deepEqual(
		meeting.posts().map((post) => post.body.message),
		[`[P1] ${NOTICE.text}`, `[P2] ${recap}`, `[P3] ${recap}`],
	);
	assert.equal(heldRecap(meeting), undefined);
});

const LEAVING = "I'm leaving: example.";

// Parlume said why it was leaving before the chat showed the join notice,
// and what waited for the join notice would have followed that line.
test("a guests notice still held when Parlume leaves is dropped, not posted after the leaving line", async () => {
	const meeting = harness();
	await meeting.channel.giveJoinNotice(NOTICE);
	meeting.guests.present = true;
	await meeting.channel.noteGuestArrived();
	await meeting.channel.leaving({ notice: LEAVING });

	await meeting.channel.receive(
		chatMessage(`[P1] ${NOTICE.text}`, { senderName: "Fabric Parlume" }),
	);
	await meeting.channel.checkDeliveries();

	assert.deepEqual(
		meeting.posts().map((post) => post.body.message),
		[`[P1] ${NOTICE.text}`, `[P2] ${LEAVING}`],
	);
	assert.deepEqual(
		meeting.events("chat.held_dropped").map((entry) => entry.meta),
		[
			{
				sessionId: "session-1",
				botId: "bot-1",
				guestsNotice: true,
				recap: false,
			},
		],
	);
});

test("a recap still held when Parlume leaves is dropped, not posted after the leaving line", async () => {
	const meeting = harness();
	await meeting.channel.expectJoinNotice();
	await meeting.channel.send({
		message: "Since last time: F-12 shipped.",
		plain: true,
	});
	await meeting.channel.giveJoinNotice(NOTICE);
	await meeting.channel.leaving({ notice: LEAVING });

	await meeting.channel.receive(
		chatMessage(`[P1] ${NOTICE.text}`, { senderName: "Fabric Parlume" }),
	);
	await meeting.channel.postHeldRecap();

	assert.deepEqual(
		meeting.posts().map((post) => post.body.message),
		[`[P1] ${NOTICE.text}`, `[P2] ${LEAVING}`],
	);
	assert.deepEqual(
		meeting.events("chat.held_dropped").map((entry) => entry.meta),
		[
			{
				sessionId: "session-1",
				botId: "bot-1",
				guestsNotice: false,
				recap: true,
			},
		],
	);
	assert.equal(heldRecap(meeting), undefined);
});

test("a join notice the chat never shows is said aloud in place of the unavailable line, once", async () => {
	const meeting = harness();

	await meeting.channel.giveJoinNotice(NOTICE);
	meeting.clock.now += 15_000;
	await meeting.channel.checkDeliveries();
	await sayUnavailable(meeting);
	await meeting.channel.checkDeliveries();

	assert.deepEqual(meeting.spoken, [NOTICE.spoken]);
	assert.deepEqual(joinNoticeReports(meeting), [
		{ sessionId: "session-1", botId: "bot-1", via: "voice" },
	]);
});

test("a join notice the chat shows just after its window is not said aloud, and Parlume never says it cannot write in the chat", async () => {
	const meeting = harness();
	await meeting.channel.giveJoinNotice(NOTICE);
	meeting.clock.now += 15_000;
	await meeting.channel.checkDeliveries();
	assert.equal(await meeting.channel.isAvailable(), false);

	meeting.clock.now += 700;
	await meeting.channel.receive(
		chatMessage(`[P1] ${NOTICE.text}`, { senderName: "Fabric Parlume" }),
	);
	await sayUnavailable(meeting);
	await meeting.channel.checkDeliveries();

	assert.deepEqual(meeting.spoken, []);
	assert.equal(meeting.events("chat.unavailable_announced").length, 0);
	assert.equal(meeting.events("chat.confirmed")[0]?.meta.late, true);
	assert.deepEqual(joinNoticeReports(meeting), [
		{ sessionId: "session-1", botId: "bot-1", via: "chat", tag: "P1" },
	]);
});

test("a join notice Fabric could not take is posted again on the next delivery check", async () => {
	let refuse = true;
	const meeting = harness({
		fabric: (path) =>
			refuse && path.endsWith("/chat")
				? new Response(null, { status: 503 })
				: Response.json({ accepted: true }),
	});

	await meeting.channel.giveJoinNotice(NOTICE);
	refuse = false;
	await meeting.channel.checkDeliveries();

	assert.deepEqual(
		meeting.posts().map((post) => post.body.message),
		[`[P1] ${NOTICE.text}`, `[P2] ${NOTICE.text}`],
	);
});

test("while a guest is in, the chat gets only the notices, and a guest's command is not acted on", async () => {
	const meeting = harness();
	meeting.guests.present = true;
	meeting.guests.ids.add("guest-1");

	const reply = plain(
		await (await meeting.channel.send({ message: "Here is F-12." })).json(),
	);
	await meeting.channel.noteGuestArrived();
	for (const sender of [
		{ senderId: "guest-1", senderName: "Visitor" },
		{
			senderId: "8:teamsvisitor:guest-2",
			senderName: "Visitor (Guest)",
			senderExternal: true,
		},
	]) {
		await meeting.channel.receive(
			chatMessage("@Fabric Parlume what changed?", sender),
		);
	}
	await flush();

	assert.deepEqual(reply, { sent: false, reason: "guests_present" });
	assert.deepEqual(
		meeting.posts().map((post) => post.body.message),
		[
			"[P1] **Notes only** · a guest is in this meeting\nI keep notes. I do not speak or answer in this chat while a guest is here.",
		],
	);
	assert.equal(meeting.turns.length, 0);

	await meeting.channel.receive(chatMessage("@Fabric Parlume what changed?"));
	await flush();
	assert.equal(
		meeting.turns.length,
		1,
		"a member's request still runs; its answer stays on the Parlume page",
	);
});

test("a typed stop phrase stops Parlume, named after its sender; 'Parlume, pause' pauses it, a guest's included", async () => {
	const meeting = harness();
	meeting.guests.ids.add("guest-1");

	await meeting.channel.receive(chatMessage("Parlume, stop talking"));
	await meeting.channel.receive(chatMessage("please stop"));
	await meeting.channel.receive(chatMessage("let's stop here"));
	await meeting.channel.receive(
		chatMessage("stop", { senderName: "Guest One", senderId: "guest-1" }),
	);
	await meeting.channel.receive(chatMessage("@Parlume pause"));
	await meeting.channel.receive(
		chatMessage("Parlume, stop listening", {
			senderName: "Guest One",
			senderId: "guest-1",
		}),
	);
	await flush();

	assert.deepEqual(meeting.stops, [
		{ name: "Dev One", id: "participant-1" },
		{ name: "Dev One", id: "participant-1" },
	]);
	assert.deepEqual(meeting.pauses, [
		{ name: "Dev One", id: "participant-1" },
		{ name: "Guest One", id: "guest-1" },
	]);
	assert.equal(meeting.turns.length, 0, "no stop or pause is a request");
});

test("'wait', 'cancel' or 'enough' said to people in the chat never stops Parlume; addressed to it, they do", async () => {
	const meeting = harness();

	for (const text of ["wait", "cancel", "enough", "hold on", "never mind"]) {
		await meeting.channel.receive(chatMessage(text));
	}
	await flush();
	assert.deepEqual(meeting.stops, [], "nobody told Parlume to stop");

	await meeting.channel.receive(chatMessage("Parlume, wait"));
	await meeting.channel.receive(chatMessage("stop talking"));
	await flush();
	assert.deepEqual(meeting.stops, [
		{ name: "Dev One", id: "participant-1" },
		{ name: "Dev One", id: "participant-1" },
	]);
	assert.equal(meeting.turns.length, 0);
});

test("the worker's posts for a stopped answer are refused, and later answers still post", async () => {
	const meeting = harness();
	meeting.stoppedGenerations.add(4);

	const stopped = plain(
		await (
			await meeting.channel.send({
				message: "The rest of the answer.",
				turnId: "turn-4",
				voiceGeneration: 4,
				final: true,
			})
		).json(),
	);
	const later = plain(
		await (
			await meeting.channel.send({
				message: "A new answer.",
				turnId: "turn-5",
				voiceGeneration: 5,
			})
		).json(),
	);

	assert.deepEqual(stopped, { sent: false, reason: "stopped" });
	assert.equal(later.sent, true);
	assert.deepEqual(
		meeting.posts().map((post) => post.body.message),
		["[P1] A new answer."],
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
