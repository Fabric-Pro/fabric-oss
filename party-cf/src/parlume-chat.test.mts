import assert from "node:assert/strict";
import test from "node:test";
import { loadParlumeModule } from "./parlume-test-runtime.mts";

const fetch = async () => Response.json({});
// Objects built inside the sandboxed module have that realm's prototypes.
const plain = (value: unknown) => JSON.parse(JSON.stringify(value));

type Message = {
	id: string;
	text: string;
	senderName: string | null;
	senderId: string | null;
	toBot: boolean;
	timestampMs: number | null;
};

const chat = loadParlumeModule("./parlume-chat.ts", fetch) as {
	PARLUME_CHAT_CONFIRM_MS: number;
	emptyParlumeChatState(): Record<string, unknown>;
	parseParlumeChatMessage(body: unknown): Message | null;
	parlumeChatTag(text: string): string | null;
	composeParlumeChatMessage(tag: string, body: string): string;
	recordParlumeChatPost(
		state: unknown,
		input: { text: string; turnId: string | null; kind: string },
		now: number,
	): { tag: string };
	observeParlumeChatMessage(
		state: unknown,
		message: Message,
		fromParlumeSender: boolean,
		now: number,
	): Record<string, unknown>;
	expireParlumeChatPosts(
		state: unknown,
		now: number,
	): { expired: Array<{ tag: string }>; becameUnavailable: boolean };
	nextParlumeChatDeadline(state: unknown): number | null;
	parlumeChatSpeech(text: string): AsyncGenerator<string>;
};
const commands = loadParlumeModule("./parlume-chat-commands.ts", fetch) as {
	parseParlumeChatCommand(
		text: string,
		toBot: boolean,
	): Record<string, unknown> | null;
};
const suggestions = loadParlumeModule("./parlume-suggestions.ts", fetch) as {
	emptyParlumeSuggestionState(now: number): {
		lastPassAt: number;
		recent: Array<{ at: number; text: string }>;
	};
	isParlumeSuggestionPassDue(
		state: unknown,
		input: { now: number; newSegments: number },
	): boolean;
	parseParlumeSuggestion(body: unknown): string | null;
	isNearDuplicateParlumeSuggestion(
		state: unknown,
		text: string,
		now: number,
	): boolean;
	acceptParlumeSuggestion(state: unknown, text: string, now: number): void;
	formatParlumeSuggestion(tag: string, text: string): string;
};

function message(overrides: Partial<Message> = {}): Message {
	return {
		id: "msg_1",
		text: "Hello",
		senderName: "Dev One",
		senderId: "participant-1",
		toBot: false,
		timestampMs: 1_000,
		...overrides,
	};
}

test("a relayed chat message is read within its bounds", () => {
	assert.deepEqual(
		plain(
			chat.parseParlumeChatMessage({
				id: "msg_1",
				text: "  Hello  ",
				senderName: "Dev One",
				senderId: "participant-1",
				toBot: true,
				timestampMs: 1_000,
			}),
		),
		{
			id: "msg_1",
			text: "Hello",
			senderName: "Dev One",
			senderId: "participant-1",
			toBot: true,
			timestampMs: 1_000,
		},
	);
	assert.equal(chat.parseParlumeChatMessage({ text: "no id" }), null);
	assert.equal(
		chat.parseParlumeChatMessage({ id: "x".repeat(129), text: "Hi" }),
		null,
	);
	assert.equal(
		chat.parseParlumeChatMessage({ id: "msg_1", text: "x".repeat(20_001) }),
		null,
	);
	assert.equal(
		chat.parseParlumeChatMessage({ id: "msg_1", text: "Hi" })?.senderName,
		null,
	);
});

test("posts are numbered per session and tagged within the chat's limit", () => {
	const state = chat.emptyParlumeChatState();
	const first = chat.recordParlumeChatPost(
		state,
		{ text: "One", turnId: "turn-1", kind: "reply" },
		0,
	);
	const second = chat.recordParlumeChatPost(
		state,
		{ text: "Two", turnId: null, kind: "suggestion" },
		0,
	);
	assert.equal(first.tag, "P1");
	assert.equal(second.tag, "P2");
	assert.equal(chat.composeParlumeChatMessage("P2", "Two"), "[P2] Two");
	const long = chat.composeParlumeChatMessage("P2", "x".repeat(5_000));
	assert.equal(long.length, 4_000);
	assert.ok(long.startsWith("[P2] x") && long.endsWith("…"));
	assert.equal(chat.parlumeChatTag("[P12] Here you go"), "P12");
	assert.equal(chat.parlumeChatTag("I mean [P12]"), null);
});

test("a post is confirmed by its own tag coming back, and keeps fifty at most", () => {
	const state = chat.emptyParlumeChatState();
	for (let index = 0; index < 55; index++) {
		chat.recordParlumeChatPost(
			state,
			{ text: `Post ${index}`, turnId: null, kind: "reply" },
			0,
		);
	}
	assert.equal((state.posts as unknown[]).length, 50);

	const observation = plain(
		chat.observeParlumeChatMessage(
			state,
			message({ text: "[P55] Post 54", senderName: "Fabric Parlume" }),
			false,
			500,
		),
	);
	assert.equal(observation.kind, "parlume");
	assert.equal(observation.confirmed.tag, "P55");
	assert.equal(observation.late, false);

	const again = plain(
		chat.observeParlumeChatMessage(
			state,
			message({ id: "msg_2", text: "[P55] Post 54" }),
			false,
			600,
		),
	);
	assert.equal(again.confirmed, null);
});

test("the same message id is seen once", () => {
	const state = chat.emptyParlumeChatState();
	assert.equal(
		chat.observeParlumeChatMessage(state, message(), false, 0).kind,
		"participant",
	);
	assert.equal(
		chat.observeParlumeChatMessage(state, message(), false, 0).kind,
		"duplicate",
	);
});

test("an unseen post goes unconfirmed after eight seconds, and marks the chat unavailable only if the chat never showed anything", () => {
	const quiet = chat.emptyParlumeChatState();
	chat.recordParlumeChatPost(
		quiet,
		{ text: "One", turnId: "turn-1", kind: "reply" },
		1_000,
	);
	assert.equal(chat.nextParlumeChatDeadline(quiet), 1_000 + 8_000);
	assert.equal(chat.expireParlumeChatPosts(quiet, 8_999).expired.length, 0);
	const expired = chat.expireParlumeChatPosts(quiet, 9_000);
	assert.deepEqual(plain(expired.expired.map((post) => post.tag)), ["P1"]);
	assert.equal(expired.becameUnavailable, true);
	assert.equal(quiet.unavailable, true);
	assert.equal(chat.nextParlumeChatDeadline(quiet), null);

	const busy = chat.emptyParlumeChatState();
	chat.observeParlumeChatMessage(busy, message(), false, 500);
	chat.recordParlumeChatPost(
		busy,
		{ text: "One", turnId: null, kind: "reply" },
		1_000,
	);
	const unconfirmed = chat.expireParlumeChatPosts(busy, 9_000);
	assert.equal(unconfirmed.expired.length, 1);
	assert.equal(unconfirmed.becameUnavailable, false);
	assert.equal(busy.unavailable, false);
});

test("any later message clears the unavailable mark, and a late echo is reported as late", () => {
	const state = chat.emptyParlumeChatState();
	chat.recordParlumeChatPost(
		state,
		{ text: "One", turnId: null, kind: "reply" },
		0,
	);
	chat.expireParlumeChatPosts(state, 8_000);
	assert.equal(state.unavailable, true);

	const observation = plain(
		chat.observeParlumeChatMessage(
			state,
			message({ text: "[P1] One" }),
			false,
			12_000,
		),
	);
	assert.equal(observation.becameAvailable, true);
	assert.equal(observation.late, true);
	assert.equal(state.unavailable, false);
});

test("a post read aloud says 'the link' for an address and is cut into sentences", async () => {
	const spoken: string[] = [];
	for await (const sentence of chat.parlumeChatSpeech(
		"F-12 · Export — https://fabric.example/app/projects/p/stories/s\nIt ships Friday. Ask Sam!",
	)) {
		spoken.push(sentence);
	}
	assert.deepEqual(spoken, [
		"F-12 · Export — the link It ships Friday.",
		"Ask Sam!",
	]);
});

test("chat commands: tags are handles, anything else must be addressed", () => {
	const parse = (text: string, toBot = false) =>
		plain(commands.parseParlumeChatCommand(text, toBot));
	assert.deepEqual(parse("say P7"), { kind: "say", tag: "P7" });
	assert.deepEqual(parse("go p7"), { kind: "go", tag: "P7" });
	assert.deepEqual(parse("Go [P7]."), { kind: "go", tag: "P7" });
	assert.deepEqual(parse("more P7"), { kind: "more", tag: "P7" });
	assert.deepEqual(parse("@Parlume more P3"), { kind: "more", tag: "P3" });
	assert.deepEqual(parse("stop"), { kind: "stop" });
	assert.deepEqual(parse("@Fabric stop!"), { kind: "stop" });
	assert.deepEqual(parse("@Fabric Parlume what changed?"), {
		kind: "ask",
		text: "what changed?",
		replyChannel: "CHAT",
	});
	assert.deepEqual(parse("Fabric Parlume what changed?"), {
		kind: "ask",
		text: "what changed?",
		replyChannel: "CHAT",
	});
	assert.deepEqual(parse("Parlume, what did they write in the chat?"), {
		kind: "ask",
		text: "what did they write in the chat?",
		replyChannel: "CHAT",
	});
	assert.deepEqual(parse("Hey Fabric tell everyone the release date"), {
		kind: "ask",
		text: "tell everyone the release date",
		replyChannel: "VOICE",
	});
	assert.deepEqual(parse("@Parlume say the summary out loud"), {
		kind: "ask",
		text: "say the summary out loud",
		replyChannel: "VOICE",
	});
	assert.deepEqual(parse("what is the plan?", true), {
		kind: "ask",
		text: "what is the plan?",
		replyChannel: "CHAT",
	});
	assert.equal(parse("Fabric is slow today"), null);
	assert.equal(parse("what is the plan?"), null);
	assert.equal(parse("Hey Fabric"), null);
	assert.equal(parse("say P7 please"), null);
	assert.equal(parse("let's stop here"), null);
});

test("a suggestion pass is due after ninety seconds and three new segments, twelve an hour at most", () => {
	const state = suggestions.emptyParlumeSuggestionState(0);
	const due = (now: number, newSegments = 3) =>
		suggestions.isParlumeSuggestionPassDue(state, { now, newSegments });
	assert.equal(due(89_999), false);
	assert.equal(due(90_000, 2), false);
	assert.equal(due(90_000), true);
	for (let index = 0; index < 12; index++) {
		suggestions.acceptParlumeSuggestion(
			state,
			`Distinct idea number ${index}`,
			index * 1_000,
		);
	}
	assert.equal(due(90_000), false);
	assert.equal(due(60 * 60 * 1000 + 1_000), true);
});

test("a suggestion is read leniently and a near-duplicate is recognized", () => {
	assert.equal(
		suggestions.parseParlumeSuggestion({
			suggest: true,
			text: "  Ask  Sam. ",
		}),
		"Ask Sam.",
	);
	assert.equal(
		suggestions.parseParlumeSuggestion({ suggest: false, text: "x" }),
		null,
	);
	assert.equal(suggestions.parseParlumeSuggestion({ suggest: true }), null);
	assert.equal(suggestions.parseParlumeSuggestion("yes"), null);

	const state = suggestions.emptyParlumeSuggestionState(0);
	suggestions.acceptParlumeSuggestion(
		state,
		"F-12 already covers the roadmap export.",
		0,
	);
	assert.equal(
		suggestions.isNearDuplicateParlumeSuggestion(
			state,
			"F-12 already covers the roadmap export!",
			1_000,
		),
		true,
	);
	assert.equal(
		suggestions.isNearDuplicateParlumeSuggestion(
			state,
			"Nobody owns the Friday deadline yet.",
			1_000,
		),
		false,
	);
	assert.equal(
		suggestions.formatParlumeSuggestion("P4", "Ask Sam."),
		'Suggestion: Ask Sam. (reply "go P4" and I\'ll say it)',
	);
});
