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
	senderExternal?: boolean;
	toBot: boolean;
	timestampMs: number | null;
};

const chat = loadParlumeModule("./parlume-chat.ts", fetch) as {
	PARLUME_CHAT_CONFIRM_MS: number;
	emptyParlumeChatState(): Record<string, unknown>;
	parseParlumeChatMessage(body: unknown): Message | null;
	parlumeChatTag(text: string): string | null;
	composeParlumeChatMessage(
		tag: string,
		body: string,
		header?: string,
		kind?: string,
	): string;
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
	parlumeSpokenPostText(text: string): string;
	parlumeChatPostRest(post: {
		tag: string;
		text: string;
		header?: string;
		kind?: string;
	}): string;
	startParlumeChatTagsAt(state: unknown, first: number): void;
	isEarlierParlumeSessionTag(state: unknown, tag: string): boolean;
	noteParlumeChatOffer(
		state: unknown,
		post: { tag: string; kind: string },
	): void;
	parlumeChatEndedText(offered: number[], proposed?: number[]): string;
	parlumeMissingPostLine(state: unknown, tag: string): string;
	PARLUME_SPOKEN_BUDGET_SECONDS: number;
	ParlumeReadChapters: new (
		now: () => number,
	) => {
		begin(text: string): string;
		readonly waiting: boolean;
		next(): string | null;
	};
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
	parseParlumeSuggestion(body: unknown): Suggestion | null;
	parseParlumeSuggestionAudience(body: unknown): "MEETING" | "TEAM" | null;
	isNearDuplicateParlumeSuggestion(
		state: unknown,
		suggestion: Pick<Suggestion, "text" | "quote">,
		now: number,
	): boolean;
	acceptParlumeSuggestion(
		state: unknown,
		suggestion: Pick<Suggestion, "text" | "quote">,
		now: number,
	): void;
	formatParlumeSuggestion(
		tag: string,
		suggestion: Suggestion,
		pageUrl?: string | null,
	): string;
	spokenParlumeSuggestion(suggestion: Suggestion): string;
};
type Suggestion = {
	kind: "answer" | "missed_question";
	text: string;
	speaker: string;
	quote: string;
	topic: string;
};
const roadmapExport: Suggestion = {
	kind: "answer",
	text: "F-12 already covers the roadmap export.",
	speaker: "Sam",
	quote: "we still need an export",
	topic: "Roadmap export",
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
	assert.equal(
		chat.parseParlumeChatMessage({
			id: "msg_2",
			text: "go P1",
			senderExternal: true,
		})?.senderExternal,
		true,
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
	assert.ok(long.length <= 600);
	assert.ok(long.startsWith("[P2] x"));
	assert.ok(
		long.endsWith(
			'…\n\nShortened for the chat. Reply "more P2" for the rest.',
		),
	);
	assert.equal(chat.parlumeChatTag("[P12] Here you go"), "P12");
	assert.equal(chat.parlumeChatTag("I mean [P12]"), null);
});

test("a post keeps its lines and its bold, and loses headings and rules", () => {
	// The shape of a real answer that lost its line breaks in a Teams
	// meeting. Fabric renders the bold it keeps as HTML.
	const body = [
		"There is **one feature** on the project roadmap.",
		"",
		"---",
		"## Verify edits keep references",
		"- **Status:** Backlog",
		"- **Priority:** Medium",
		"Keeps `[S1]` and __[S2]__ intact.",
	].join("\n");

	assert.equal(
		chat.composeParlumeChatMessage("P2", body),
		[
			"[P2] There is **one feature** on the project roadmap.",
			"",
			"Verify edits keep references",
			"• **Status:** Backlog",
			"• **Priority:** Medium",
			"Keeps `[S1]` and __[S2]__ intact.",
		].join("\n"),
	);
});

test("a numbered list keeps its numbers, and blank lines stay one paragraph break", () => {
	assert.equal(
		chat.composeParlumeChatMessage(
			"P3",
			"Two steps:\n\n\n\n1) Export the board\n2. Share it",
		),
		"[P3] Two steps:\n\n1. Export the board\n2. Share it",
	);
});

test("a long answer is shortened at a line, never mid-word, and says how to get the rest", () => {
	const line = `${"word ".repeat(39)}end.`;
	const body = Array.from({ length: 12 }, () => line).join("\n");

	const post = chat.composeParlumeChatMessage("P4", body);

	assert.ok(post.length <= 600);
	const [shown, pointer] = post.split("\n\n");
	assert.ok(shown.endsWith(" end."), "no ellipsis after a full stop");
	assert.equal(
		pointer,
		'Shortened for the chat. Reply "more P4" for the rest.',
	);
	const rest = chat.parlumeChatPostRest({ tag: "P4", text: body });
	assert.equal(
		`${shown.slice("[P4] ".length)}\n${rest}`,
		body,
		"the shown part and the rest together are the whole answer",
	);
	assert.equal(chat.parlumeChatPostRest({ tag: "P4", text: line }), "");
});

// Staging, 2026-11-21: an answer posted as 10 lines and 1,438 characters,
// under the old 1,500-character cap, though a post should be a few lines.
test("an answer shows at most eight lines under its header, and the rest waits for more", () => {
	const header = "**Answer** for Alex\n*“What changed in the release?”*";
	const body = Array.from(
		{ length: 10 },
		(_, index) => `- F-${index + 1} ships with the release.`,
	).join("\n");

	const post = chat.composeParlumeChatMessage("P3", body, header);

	assert.ok(post.length < 600);
	const lines = post.split("\n");
	assert.deepEqual(lines.slice(0, 2), [
		"[P3] **Answer** for Alex",
		"*“What changed in the release?”*",
	]);
	assert.equal(lines.slice(2, -2).length, 8);
	assert.equal(lines.at(-3), "• F-8 ships with the release.");
	assert.equal(
		lines.at(-1),
		'Shortened for the chat. Reply "more P3" for the rest.',
	);
	assert.equal(
		chat.parlumeChatPostRest({ tag: "P3", text: body, header }),
		"• F-9 ships with the release.\n• F-10 ships with the release.",
	);

	const eight = body.split("\n").slice(0, 8).join("\n");
	assert.ok(
		!chat
			.composeParlumeChatMessage("P4", eight, header)
			.includes("Shortened"),
		"eight lines are posted whole",
	);
});

test("a proposal is posted whole, so its Confirm and Dismiss links never wait behind more", () => {
	const url = `https://fabric.example/app/example-org/projects/${"p".repeat(25)}/parlume/actions/${"a".repeat(25)}`;
	const body = [
		"**Proposed change** · not made yet",
		`Create feature “${"Export ".repeat(12).trim()}” in Example project`,
		`Asked by Alex: “${"create the export feature ".repeat(4).trim()}”`,
		"Priority: High · Status: Backlog · Owner: Sam",
		`[Confirm in Fabric](${url}) · [Dismiss](${url}?intent=dismiss)`,
		"Only a signed-in project member can confirm. Open for 24 hours.",
	].join("\n");

	const post = chat.composeParlumeChatMessage(
		"P7",
		body,
		undefined,
		"proposal",
	);

	assert.ok(post.length > 600);
	assert.equal(post, `[P7] ${body}`);
	assert.equal(
		chat.parlumeChatPostRest({ tag: "P7", text: body, kind: "proposal" }),
		"",
	);
});

// A post cut right after "[S2]." added "…", which read as four dots.
test("a shortened post adds an ellipsis only where the cut leaves a sentence unfinished", () => {
	const ended = Array.from(
		{ length: 12 },
		() => `${"word ".repeat(36)}(see [S2].)`,
	).join("\n");
	const [endedShown] = chat
		.composeParlumeChatMessage("P9", ended)
		.split("\n\n");
	assert.ok(endedShown.endsWith("(see [S2].)"), endedShown.slice(-20));

	const unfinished = Array.from({ length: 12 }, () =>
		"word ".repeat(40).trim(),
	).join("\n");
	const [unfinishedShown] = chat
		.composeParlumeChatMessage("P10", unfinished)
		.split("\n\n");
	assert.ok(unfinishedShown.endsWith("word…"), unfinishedShown.slice(-20));
});

test("a confirmation with mixed outcomes keeps every outcome on its own line", () => {
	assert.equal(
		chat.composeParlumeChatMessage(
			"P5",
			"Created F-12, Export fails on large projects.\n- Tracker sync: unavailable.\n- Assignment to Sam: unconfirmed.",
		),
		"[P5] Created F-12, Export fails on large projects.\n• Tracker sync: unavailable.\n• Assignment to Sam: unconfirmed.",
	);
});

// Shortened to its first lines, "Created F-12" read as full success while
// the sync and the assignment that did not happen waited behind "more".
test("a shortened confirmation quotes the rest's outcome that did not complete", () => {
	const detail = `${"The export now streams rows in pages of five hundred. ".repeat(30)}`;
	const body = `Created F-12, Export fails on large projects.\n\n${detail}\n\nTracker sync unavailable.\nThe assignment to Sam could not be confirmed.`;

	const post = chat.composeParlumeChatMessage("P6", body);

	assert.ok(post.length <= 600);
	assert.ok(post.startsWith("[P6] Created F-12"));
	assert.ok(
		post.endsWith(
			'.\n\nShortened for the chat. The rest also says: “Tracker sync unavailable.” Reply "more P6" for all of it.',
		),
	);
	const rest = chat.parlumeChatPostRest({ tag: "P6", text: body });
	assert.match(rest, /Tracker sync unavailable\./);
	assert.match(rest, /could not be confirmed\.$/);

	const succeeded = chat.composeParlumeChatMessage(
		"P7",
		`Created F-12, Export fails on large projects.\n\n${detail}\n\nAssigned to Sam.`,
	);
	assert.ok(
		succeeded.endsWith(
			'.\n\nShortened for the chat. Reply "more P7" for the rest.',
		),
	);
});

test("a shortened answer quotes however the rest words an outcome that did not complete", () => {
	const detail = "Rows now stream in pages. ".repeat(80);
	for (const outcome of [
		"Moving F-13 was rejected by the project policy.",
		"I was unable to assign Sam.",
		"I can't reach the tracker.",
		"The tracker sync was cancelled.",
		"Permission denied for the release board.",
		"F-14 has not been updated.",
		"The update was interrupted, so its outcome is unknown.",
	]) {
		const post = chat.composeParlumeChatMessage(
			"P8",
			`Created F-12.\n\n${detail}\n\n${outcome}`,
		);

		assert.ok(post.length <= 600, outcome);
		assert.ok(
			post.endsWith(
				`.\n\nShortened for the chat. The rest also says: “${outcome}” Reply "more P8" for all of it.`,
			),
			outcome,
		);
	}
});

// A long release plan whose rest named "rejected" defects was posted with
// "The rest says something did not complete or is unconfirmed", though
// nothing had failed: the pointer quotes the rest, never sums it up.
test("a shortened answer never claims a failure the rest does not state", () => {
	const detail = "Run each check in a test environment. ".repeat(40);
	const post = chat.composeParlumeChatMessage(
		"P38",
		`Release test plan.\n\n${detail}\n\nReopen any rejected defects before sign-off.`,
	);

	assert.ok(post.length <= 600);
	assert.doesNotMatch(post, /did not complete|unconfirmed/);
	assert.ok(
		post.endsWith(
			'Shortened for the chat. The rest also says: “Reopen any rejected defects before sign-off.” Reply "more P38" for all of it.',
		),
	);
});

test("a session continues the meeting's numbering and knows an earlier session's tags", () => {
	const state = chat.emptyParlumeChatState();
	chat.startParlumeChatTagsAt(state, 4);
	const post = chat.recordParlumeChatPost(
		state,
		{ text: "One", turnId: null, kind: "reply" },
		0,
	);
	assert.equal(post.tag, "P4");
	assert.equal(chat.isEarlierParlumeSessionTag(state, "P3"), true);
	assert.equal(chat.isEarlierParlumeSessionTag(state, "P4"), false);
	assert.equal(
		chat.isEarlierParlumeSessionTag(chat.emptyParlumeChatState(), "P1"),
		false,
		"a state stored before the numbering continued starts at P1",
	);
});

test("a post is confirmed by its own tag coming back, and the delivery of fifty at most is tracked", () => {
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

test("a session keeps the tags of the offers Fabric took to send, notices aside and proposals apart", () => {
	const state = chat.emptyParlumeChatState();
	chat.noteParlumeChatOffer(state, { tag: "P3", kind: "notice" });
	assert.equal(state.offered, undefined, "a notice offers nothing");
	chat.noteParlumeChatOffer(state, { tag: "P4", kind: "reply" });
	chat.noteParlumeChatOffer(state, { tag: "P5", kind: "suggestion" });
	chat.noteParlumeChatOffer(state, { tag: "P6", kind: "notice" });
	chat.noteParlumeChatOffer(state, { tag: "P7", kind: "proposal" });

	assert.deepEqual(plain(state.offered), [4, 5]);
	assert.deepEqual(plain(state.proposed), [7]);
});

test("the leaving line names each offered tag, consecutive ones as a range", () => {
	const ended = (tags: string) =>
		`Unavailable: ${tags}. This meeting has ended for Parlume, so these posts can no longer be played.`;

	assert.equal(chat.parlumeChatEndedText([4]), ended("P4"));
	assert.equal(chat.parlumeChatEndedText([4, 5]), ended("P4 to P5"));
	// P6 was a notice and P8 was refused: neither was an offer.
	assert.equal(
		chat.parlumeChatEndedText([9, 4, 5, 7]),
		ended("P4 to P5, P7, P9"),
	);
});

// The leaving line called a confirmed proposal and its done line "earlier
// answers", while the proposal still showed its Confirm link.
test("the leaving line names a proposed change apart from the posts that can no longer be played", () => {
	assert.equal(
		chat.parlumeChatEndedText([35, 36, 43], [42]),
		"Unavailable: P35 to P36, P43. This meeting has ended for Parlume, so these posts can no longer be played. The proposed change P42 stays on its page in Fabric.",
	);
	assert.equal(
		chat.parlumeChatEndedText([], [42, 44]),
		"This meeting has ended for Parlume. The proposed changes P42, P44 stay on their pages in Fabric.",
	);
});

test("a tag the session has no post for is answered with what became of it", () => {
	const state = chat.emptyParlumeChatState();
	chat.startParlumeChatTagsAt(state, 4);
	for (const text of ["One", "Two"]) {
		chat.recordParlumeChatPost(
			state,
			{ text, turnId: null, kind: "reply" },
			0,
		);
	}

	assert.equal(
		chat.parlumeMissingPostLine(state, "P2"),
		"P2: This meeting has ended for the Parlume session that posted it, so it can no longer be played.",
	);
	assert.equal(
		chat.parlumeMissingPostLine(state, "P5"),
		"P5: This prepared answer is no longer available. Ask me again.",
		"a tag this session issued",
	);
	assert.equal(
		chat.parlumeMissingPostLine(state, "P99"),
		"P99: There is no P99 in this meeting's chat. Check the tag on the post you mean.",
		"a tag no post carried",
	);
	assert.equal(
		chat.parlumeMissingPostLine(state, "P0"),
		"P0: There is no P0 in this meeting's chat. Check the tag on the post you mean.",
	);
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

test("an unseen post goes unconfirmed after fifteen seconds, and marks the chat unavailable only if the chat never showed anything", () => {
	const quiet = chat.emptyParlumeChatState();
	chat.recordParlumeChatPost(
		quiet,
		{ text: "One", turnId: "turn-1", kind: "reply" },
		1_000,
	);
	assert.equal(chat.nextParlumeChatDeadline(quiet), 1_000 + 15_000);
	assert.equal(chat.expireParlumeChatPosts(quiet, 15_999).expired.length, 0);
	const expired = chat.expireParlumeChatPosts(quiet, 16_000);
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
	const unconfirmed = chat.expireParlumeChatPosts(busy, 16_000);
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
	chat.expireParlumeChatPosts(state, 15_000);
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

test("a post read aloud says a titled link's title, 'the link' for an untitled address, and is cut into sentences", async () => {
	const spoken: string[] = [];
	for await (const sentence of chat.parlumeChatSpeech(
		"F-12 · Export — https://fabric.example/app/projects/p/stories/s\nIt ships Friday. Ask Sam!\nNotes at https://fabric.example/notes today.",
	)) {
		spoken.push(sentence);
	}
	assert.deepEqual(spoken, [
		"F-12 · Export.",
		"It ships Friday.",
		"Ask Sam!",
		"Notes at the link today.",
	]);
});

// A list of page links, each title over its address, was read "Overview.
// The link. Roadmap. The link. …".
test("a link list read aloud says each title once, never 'the link' after it", () => {
	assert.equal(
		chat.parlumeSpokenPostText(
			[
				"Here are the project's main pages:",
				"Overview",
				"https://fabric.example/app/projects/p?tab=overview",
				"Roadmap: https://fabric.example/app/projects/p?tab=stories",
				"- https://fabric.example/app/projects/p?tab=documents",
			].join("\n"),
		),
		"Here are the project's main pages: Overview. Roadmap.",
	);
	assert.equal(
		chat.parlumeSpokenPostText("https://fabric.example/app/projects/p"),
		"the link.",
		"a post that is only an address still says it",
	);
});

test("a post read aloud never reads its formatting: titles for links, items as sentences", () => {
	assert.equal(
		chat.parlumeSpokenPostText(
			[
				"## Release plan",
				"- **F-12** ships `Friday`",
				"2) See the [release notes](https://fabric.example/notes?a=1)",
				"---",
				"Done!",
			].join("\n"),
		),
		"Release plan. F-12 ships Friday. See the release notes. Done!",
	);
});

const CONTINUE_HINT =
	"There is more. Ask me to continue, or type continue in the chat.";

/** A post of about 6,000 characters, in sentences. */
function longPost(): string {
	const sentences: string[] = [];
	for (let item = 1; sentences.join(" ").length < 5_900; item++) {
		sentences.push(
			`Item ${item} of the release plan needs one more review before Friday.`,
		);
	}
	return sentences.join(" ");
}

test("a long post is read in chapters that end where its sentences end, each within the spoken budget, saying how to hear the next", () => {
	const post = longPost();
	const chapters = new chat.ParlumeReadChapters(() => 0);
	const read = [chapters.begin(post)];
	for (let next = chapters.next(); next !== null; next = chapters.next()) {
		read.push(next);
	}

	// At about 15 characters a second.
	const budget = chat.PARLUME_SPOKEN_BUDGET_SECONDS * 15;
	assert.ok(read.length >= 9, `${read.length} chapters`);
	const bodies = read.map((chapter, index) => {
		assert.ok(chapter.length <= budget, `chapter ${index} is too long`);
		const last = index === read.length - 1;
		assert.equal(chapter.endsWith(` ${CONTINUE_HINT}`), !last);
		const body = last
			? chapter
			: chapter.slice(0, -(CONTINUE_HINT.length + 1));
		assert.match(body, /[.!?]$/, `chapter ${index} ends a sentence`);
		return body;
	});
	assert.equal(bodies.join(" "), chat.parlumeSpokenPostText(post));
	assert.equal(chapters.waiting, false);
});

test("a short post is read whole, with nothing left to continue", () => {
	const chapters = new chat.ParlumeReadChapters(() => 0);

	assert.equal(chapters.begin("Two items remain."), "Two items remain.");
	assert.equal(chapters.waiting, false);
	assert.equal(chapters.next(), null);
});

test("the rest of a post read in chapters waits five minutes from the last chapter read to be asked for", () => {
	let now = 0;
	const chapters = new chat.ParlumeReadChapters(() => now);
	chapters.begin(longPost());

	now += 4 * 60_000;
	assert.equal(chapters.waiting, true);
	assert.match(chapters.next() ?? "", /^Item \d+ /);
	now += 4 * 60_000;
	assert.equal(chapters.waiting, true, "each chapter read starts the wait");
	now += 60_000 + 1;
	assert.equal(chapters.waiting, false);
	assert.equal(chapters.next(), null);
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
	// Unaddressed, only a plain stop stops Parlume.
	for (const phrase of [
		"stop talking",
		"Stop speaking.",
		"please stop",
		"okay stop",
		"stop please!",
	]) {
		assert.deepEqual(parse(phrase), { kind: "stop" }, phrase);
	}
	// The softer phrases are often said to people: they stop Parlume only
	// when it is addressed.
	for (const phrase of [
		"Parlume, wait",
		"Fabric, never mind",
		"Parlume, that’s enough",
		"Parlume, be quiet",
		"@Fabric cancel",
		"Hey Parlume hold on",
	]) {
		assert.deepEqual(parse(phrase), { kind: "stop" }, phrase);
	}
	assert.deepEqual(parse("hold on", true), { kind: "stop" });
	for (const phrase of [
		"wait",
		"cancel",
		"enough",
		"quiet",
		"hold on",
		"never mind",
		"not that",
		"that's enough",
	]) {
		assert.equal(parse(phrase), null, `unaddressed "${phrase}"`);
	}
	assert.deepEqual(parse("Parlume, pause"), { kind: "pause" });
	assert.deepEqual(parse("@Parlume stop listening."), { kind: "pause" });
	assert.deepEqual(parse("pause", true), { kind: "pause" });
	assert.equal(parse("pause"), null, "a pause must be addressed");
	// "continue" asks for the next chapter of a post read aloud, addressed or
	// not; it acts only while one waits.
	for (const phrase of ["continue", "Go on.", "please keep reading"]) {
		assert.deepEqual(parse(phrase), { kind: "continue" }, phrase);
	}
	assert.deepEqual(parse("Parlume, continue"), { kind: "continue" });
	assert.deepEqual(parse("@Fabric continue please"), { kind: "continue" });
	assert.equal(parse("stop listening"), null);
	assert.equal(parse("stop the deploy"), null);
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
	// Said aloud this wakes Parlume; typed, the address must come first.
	assert.equal(parse("Thanks all. Parlume, what changed?"), null);
});

test("chat commands: a post command typed takes every form it takes spoken", () => {
	const parse = (text: string, toBot = false) =>
		plain(commands.parseParlumeChatCommand(text, toBot));
	const typed: Array<[string, Record<string, unknown>]> = [
		["read P3", { kind: "say", tag: "P3" }],
		["Read [P3].", { kind: "say", tag: "P3" }],
		["please read post P3", { kind: "say", tag: "P3" }],
		["more on P3", { kind: "more", tag: "P3" }],
		["more about P3?", { kind: "more", tag: "P3" }],
		["tell me more about P3?", { kind: "more", tag: "P3" }],
		["tell us more on [P12]", { kind: "more", tag: "P12" }],
		["go ahead with P4", { kind: "go", tag: "P4" }],
		["go with P4!", { kind: "go", tag: "P4" }],
		["go P4?", { kind: "go", tag: "P4" }],
		["say P 7", { kind: "say", tag: "P7" }],
		["say P seven", { kind: "say", tag: "P7" }],
		["more P thirty one", { kind: "more", tag: "P31" }],
		["Parlume, read P3?", { kind: "say", tag: "P3" }],
		["@Fabric more on P3", { kind: "more", tag: "P3" }],
	];
	for (const [text, command] of typed) {
		assert.deepEqual(parse(text), command, text);
	}
	// The spoken grammar keeps "continue" as its own command.
	assert.deepEqual(parse("continue"), { kind: "continue" });
	assert.deepEqual(parse("Parlume, keep going"), { kind: "continue" });
	// Help must be addressed: a bare "help" is said to people.
	for (const phrase of [
		"Parlume, help",
		"@Parlume help?",
		"Hey Fabric, what can I type?",
		"Parlume, commands",
	]) {
		assert.deepEqual(parse(phrase), { kind: "help" }, phrase);
	}
	assert.deepEqual(parse("help", true), { kind: "help" });
	assert.equal(parse("help"), null);
	assert.equal(parse("can someone help?"), null);
	// A message that opens with a tag is Parlume's own post shown back.
	for (const text of [
		"[P3] go P4",
		"[P3] more on P4?",
		"[P3] stop",
		"[P3] continue",
		"P3 go",
	]) {
		assert.equal(parse(text), null, text);
	}
	assert.equal(parse("go P0"), null);
	assert.equal(parse("read P3 to everyone"), null);
});

test("a suggestion pass is due on two new segments, 45 seconds after the last pass; one is posted every two minutes, ten an hour at most", () => {
	const state = suggestions.emptyParlumeSuggestionState(0);
	const due = (now: number, newSegments = 2) =>
		suggestions.isParlumeSuggestionPassDue(state, { now, newSegments });
	assert.equal(due(0, 1), false);
	assert.equal(due(0), true, "the first pass waits for no interval");
	state.lastPassAt = 0;
	assert.equal(due(44_999), false);
	assert.equal(due(45_000), true);
	suggestions.acceptParlumeSuggestion(state, roadmapExport, 0);
	assert.equal(due(119_999), false, "two minutes after the last post");
	assert.equal(due(120_000), true);
	for (let index = 1; index < 10; index++) {
		suggestions.acceptParlumeSuggestion(
			state,
			{ text: `Distinct idea number ${index}`, quote: `remark ${index}` },
			index * 120_000,
		);
	}
	assert.equal(due(1_200_000), false, "ten within the hour");
	assert.equal(due(60 * 60 * 1000 + 120_000), true);
});

test("a suggestion is read leniently, names the remark it answers, and a near-duplicate is recognized", () => {
	assert.deepEqual(
		{
			...suggestions.parseParlumeSuggestion({
				suggest: true,
				...roadmapExport,
				text: "  F-12 already covers   the roadmap export. ",
			}),
		},
		roadmapExport,
	);
	assert.equal(
		suggestions.parseParlumeSuggestion({
			...roadmapExport,
			suggest: false,
		}),
		null,
	);
	assert.equal(
		suggestions.parseParlumeSuggestion({
			suggest: true,
			text: "Ask Sam.",
		}),
		null,
		"a suggestion that names no remark is not posted",
	);
	assert.equal(suggestions.parseParlumeSuggestion("yes"), null);

	const state = suggestions.emptyParlumeSuggestionState(0);
	suggestions.acceptParlumeSuggestion(state, roadmapExport, 0);
	assert.equal(
		suggestions.isNearDuplicateParlumeSuggestion(
			state,
			{
				text: "F-12 already covers the roadmap export!",
				quote: "something else",
			},
			1_000,
		),
		true,
	);
	assert.equal(
		suggestions.isNearDuplicateParlumeSuggestion(
			state,
			{
				text: "The export is on the roadmap.",
				quote: "We still need an export",
			},
			1_000,
		),
		true,
		"a remark already answered",
	);
	assert.equal(
		suggestions.isNearDuplicateParlumeSuggestion(
			state,
			{
				text: "Nobody owns the Friday deadline yet.",
				quote: "by Friday",
			},
			1_000,
		),
		false,
	);
	// Suggestions keep their one-paragraph shape: the meeting-chat
	// formatting of answers and results does not apply to them.
	assert.equal(
		suggestions.formatParlumeSuggestion("P4", roadmapExport),
		'Suggestion on Roadmap export, re Sam: "we still need an export". F-12 already covers the roadmap export. (reply "go P4" and I\'ll say it)',
	);
	assert.equal(
		chat.composeParlumeChatMessage(
			"P4",
			suggestions.formatParlumeSuggestion("P4", roadmapExport),
		),
		'[P4] Suggestion on Roadmap export, re Sam: "we still need an export". F-12 already covers the roadmap export. (reply "go P4" and I\'ll say it)',
	);
	// Suggestions keep their spoken lead, as they keep their chat layout.
	assert.equal(
		suggestions.spokenParlumeSuggestion(roadmapExport),
		"Sam, on Roadmap export: F-12 already covers the roadmap export.",
	);
});

test("a suggestion post ends with one Say it link to the Parlume page, open on that suggestion", () => {
	assert.equal(
		suggestions.formatParlumeSuggestion(
			"P4",
			roadmapExport,
			"https://fabric.example/app/example-org/projects/p1/parlume",
		),
		'Suggestion on Roadmap export, re Sam: "we still need an export". F-12 already covers the roadmap export. (reply "go P4" and I\'ll say it)\n[Say it](https://fabric.example/app/example-org/projects/p1/parlume?suggestion=P4)',
	);
	// A Fabric that sends no page gets the post as before.
	assert.equal(
		suggestions.formatParlumeSuggestion("P4", roadmapExport, null),
		suggestions.formatParlumeSuggestion("P4", roadmapExport),
	);
});

test("a suggestion's kind is an answer unless it says it is a missed question", () => {
	const { kind: _kind, ...withoutKind } = roadmapExport;
	const kindOf = (kind: unknown) =>
		suggestions.parseParlumeSuggestion({
			suggest: true,
			...withoutKind,
			...(kind === undefined ? {} : { kind }),
		})?.kind;

	assert.equal(kindOf(undefined), "answer", "a prompt that never asks");
	assert.equal(kindOf("something_else"), "answer");
	assert.equal(kindOf("missed_question"), "missed_question");
});

test("a missed question is posted and spoken as a question to ask", () => {
	const missed: Suggestion = {
		kind: "missed_question",
		text: "Who signs off the data migration before go-live?",
		speaker: "Alex",
		quote: "we move the data in March",
		topic: "Data migration",
	};

	assert.equal(
		suggestions.formatParlumeSuggestion("P3", missed),
		'Possibly missed question on Data migration, re Alex: "we move the data in March". Who signs off the data migration before go-live? (reply "go P3" and I\'ll ask it)',
	);
	assert.equal(
		suggestions.spokenParlumeSuggestion(missed),
		"A question we may not have covered on Data migration: Who signs off the data migration before go-live?",
	);
});

test("only an explicit TEAM keeps a suggestion off the chat, and an unknown audience is refused", () => {
	const audience = (value: unknown) =>
		suggestions.parseParlumeSuggestionAudience({
			suggest: true,
			...(value === undefined ? {} : { audience: value }),
		});

	assert.equal(audience("TEAM"), "TEAM");
	assert.equal(audience("MEETING"), "MEETING");
	assert.equal(audience(undefined), "MEETING", "a Fabric without audiences");
	assert.equal(audience("EVERYONE"), null);
	assert.equal(suggestions.parseParlumeSuggestionAudience("yes"), null);
});
