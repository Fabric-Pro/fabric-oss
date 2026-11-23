import assert from "node:assert/strict";
import test from "node:test";
import { loadParlumeModule } from "./parlume-test-runtime.mts";

// Each post Parlume makes for a request, as the bridge composes it and as
// Fabric renders it for Teams (`parlumeChatHtml`, loaded from the web app's
// API package). Suggestions and the recap stay one plain paragraph, by an
// earlier deliberate change, and are not among these templates.

const fetch = async () => Response.json({});
const plain = (value: unknown) => JSON.parse(JSON.stringify(value));

type Header = {
	kind: "answer" | "detail" | "error";
	asker: string | null;
	request: string;
};

const templates = loadParlumeModule("./parlume-post-templates.ts", fetch) as {
	parlumeTurnPostHeader(header: Header): string;
	parlumeRestPostHeader(tag: string): string;
	PARLUME_HELP_TEXT: string;
};
const chat = loadParlumeModule("./parlume-chat.ts", fetch) as {
	composeParlumeChatMessage(
		tag: string,
		body: string,
		header?: string,
	): string;
	emptyParlumeChatState(): Record<string, unknown>;
	recordParlumeChatPost(
		state: unknown,
		input: {
			text: string;
			header?: string;
			turnId: string | null;
			kind: string;
		},
		now: number,
	): Record<string, unknown>;
	parlumeChatPostRest(post: unknown): string;
};
const guests = loadParlumeModule("./parlume-guests.ts", fetch) as {
	PARLUME_GUESTS_NOTICE: string;
};
const html = loadParlumeModule(
	"../../packages/api/modules/projects/lib/parlume-chat-html.ts",
	fetch,
) as { parlumeChatHtml(message: string): string };

const PAGE_URL =
	"https://fabric.example.com/app/example-org/example-project/parlume";

const samples: Array<{
	name: string;
	message: string;
	label: string;
	html: string;
}> = [
	{
		name: "answer",
		message: chat.composeParlumeChatMessage(
			"P7",
			[
				"Two features are open.",
				"F-12 Export to CSV — https://fabric.example.com/p/f-12",
				"F-13 Export to PDF — https://fabric.example.com/p/f-13",
			].join("\n"),
			templates.parlumeTurnPostHeader({
				kind: "answer",
				asker: "Alex",
				request: "Which features are open for the export?",
			}),
		),
		label: "[P7] **Answer** for Alex",
		html: '<p>[P7] <b>Answer</b> for Alex<br><i>“Which features are open for the export?”</i><br>Two features are open.<br><a href="https://fabric.example.com/p/f-12">F-12 Export to CSV</a><br><a href="https://fabric.example.com/p/f-13">F-13 Export to PDF</a></p>',
	},
	{
		name: "detail",
		message: chat.composeParlumeChatMessage(
			"P11",
			"- Login fails on Safari\n- Export drops the header row",
			templates.parlumeTurnPostHeader({
				kind: "detail",
				asker: null,
				request: "list the open bugs",
			}),
		),
		label: "[P11] **Detail**",
		html: "<p>[P11] <b>Detail</b><br><i>“list the open bugs”</i><br>• Login fails on Safari<br>• Export drops the header row</p>",
	},
	{
		name: "error",
		message: chat.composeParlumeChatMessage(
			"P8",
			`I could not finish the answer. Ask again in a minute.\n[Parlume page](${PAGE_URL})`,
			templates.parlumeTurnPostHeader({
				kind: "error",
				asker: "Alex",
				request: "What changed since Monday?",
			}),
		),
		label: "[P8] **Could not answer** Alex",
		html: `<p>[P8] <b>Could not answer</b> Alex<br><i>“What changed since Monday?”</i><br>I could not finish the answer. Ask again in a minute.<br><a href="${PAGE_URL}">Parlume page</a></p>`,
	},
	{
		name: "rest",
		message: chat.composeParlumeChatMessage(
			"P9",
			"F-14 Import from CSV — https://fabric.example.com/p/f-14",
			templates.parlumeRestPostHeader("P7"),
		),
		label: "[P9] **Rest of P7**",
		html: '<p>[P9] <b>Rest of P7</b><br><a href="https://fabric.example.com/p/f-14">F-14 Import from CSV</a></p>',
	},
	{
		name: "help",
		message: chat.composeParlumeChatMessage(
			"P10",
			templates.PARLUME_HELP_TEXT,
		),
		label: "[P10] **What you can type**",
		html: "<p>[P10] <b>What you can type</b><br>go P4 · I say post P4 aloud<br>more P4 · the rest of P4, or more detail<br>continue · the next part of a post I am reading<br>stop · I stop speaking<br>Parlume, pause · I stop listening<br>Changes need a Confirm click in Fabric.</p>",
	},
	{
		name: "notice",
		message: chat.composeParlumeChatMessage(
			"P12",
			guests.PARLUME_GUESTS_NOTICE,
		),
		label: "[P12] **Notes only**",
		html: "<p>[P12] <b>Notes only</b> · a guest is in this meeting<br>I keep notes. I do not speak or answer in this chat while a guest is here.</p>",
	},
];

/** A line that asks the reader to do one thing: type a command, or open a link. */
const ACTION_LINE = /(?:^|\s)(?:Type|Reply) "|\]\(https?:\/\//;

for (const sample of samples) {
	test(`the ${sample.name} post opens with its tag and label, asks for one thing at most, and renders for Teams`, () => {
		const lines = sample.message.split("\n");
		assert.ok(
			lines[0]?.startsWith(sample.label),
			`${sample.name}: ${lines[0]}`,
		);
		assert.ok(
			lines.filter((line) => ACTION_LINE.test(line)).length <= 1,
			sample.name,
		);
		assert.ok(sample.message.length < 600, sample.name);
		assert.equal(html.parlumeChatHtml(sample.message), sample.html);
	});
}

test("the header quotes the request on one line, cut to 120 characters, with no marks the chat would read", () => {
	const header = templates.parlumeTurnPostHeader({
		kind: "answer",
		asker: "**Alex**",
		request: `Please *bold* this:\n${"word ".repeat(40)}`,
	});
	const [label, quote] = header.split("\n");

	assert.equal(label, "**Answer** for Alex");
	assert.ok(quote?.startsWith("*“Please bold this: word word"));
	assert.ok(quote?.endsWith("…”*"));
	// The quote's own text, between the italics and the quote marks.
	assert.ok((quote?.length ?? 0) - "*“”*".length <= 120);
});

test("a shortened answer keeps its header whole and ends with one line that names more", () => {
	const header = templates.parlumeTurnPostHeader({
		kind: "answer",
		asker: "Alex",
		request: "What is in the release?",
	});
	const line = `${"word ".repeat(39)}end.`;
	const body = Array.from({ length: 12 }, (_, index) =>
		line.replace("end.", `end ${index}.`),
	).join("\n");
	const state = chat.emptyParlumeChatState();
	const post = chat.recordParlumeChatPost(
		state,
		{ text: body, header, turnId: "turn-1", kind: "reply" },
		1_000,
	);

	const message = chat.composeParlumeChatMessage(
		String(post.tag),
		body,
		header,
	);

	assert.ok(message.startsWith(`[P1] ${header}\nword`));
	assert.ok(message.length <= 600);
	assert.equal(
		message.split("\n").at(-1),
		'Shortened for the chat. Reply "more P1" for the rest.',
	);
	const rest = chat.parlumeChatPostRest(plain(post));
	assert.ok(rest.includes("end 11."));
	assert.ok(!message.includes("end 11."));
	// Nothing of the header is in the rest, so "more" never repeats it.
	assert.ok(!rest.includes("What is in the release?"));
});
