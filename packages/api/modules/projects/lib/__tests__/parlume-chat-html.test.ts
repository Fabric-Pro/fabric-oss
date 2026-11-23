import { describe, expect, it } from "vitest";
import { parlumeChatHtml, parlumePlainChatHtml } from "../parlume-chat-html";

// Suggestions and the recap are excluded from the meeting-chat formatting
// of answers and results: they stay one escaped paragraph.
describe("parlumePlainChatHtml", () => {
	it("keeps one paragraph, with no lines, links or emphasis", () => {
		expect(
			parlumePlainChatHtml(
				"[P1] Since last time\n• **F-12** shipped: https://example.com/a?b=1&c=2\n• F-13 <blocked>.",
			),
		).toBe(
			"<p>[P1] Since last time • F-12 shipped: https://example.com/a?b=1&amp;c=2 • F-13 &lt;blocked&gt;.</p>",
		);
	});

	it("links a suggestion's Say it action, and only a Markdown link", () => {
		expect(
			parlumePlainChatHtml(
				'[P3] Suggestion on exports, re Dev: "can we?". Use the CSV export (reply "go P3" and I\'ll say it)\n[Say it](https://fabric.example/app/example-org/projects/p1/parlume?suggestion=P3)',
			),
		).toBe(
			'<p>[P3] Suggestion on exports, re Dev: "can we?". Use the CSV export (reply "go P3" and I\'ll say it) <a href="https://fabric.example/app/example-org/projects/p1/parlume?suggestion=P3">Say it</a></p>',
		);
	});
});

// Attendee documents <p>, <br>, <b>, <i> and <a> for Teams chat; a post must
// use nothing else and show no Markdown symbols.
const ALLOWED_TAGS = /<\/?(?:p|br|b|i|a)(?:\s[^>]*)?>/g;

describe("parlumeChatHtml", () => {
	it("gives each line a line and each blank-line block a paragraph", () => {
		expect(
			parlumeChatHtml(
				"[P1] Since last time\n• F-12 shipped.\n• F-13 is blocked.\n\nNext: the export.",
			),
		).toBe(
			"<p>[P1] Since last time<br>• F-12 shipped.<br>• F-13 is blocked.</p><p>Next: the export.</p>",
		);
	});

	it("links a title to its address, never showing the address", () => {
		expect(
			parlumeChatHtml(
				[
					"[P4] Here are the links:",
					"",
					"F-12 · Export — https://example.com/app/example-org/projects/p1/stories/s1?tab=a&b=1.",
					"• Coding instructions: https://example.com/app/example-org/projects/p1?tab=coding-instructions",
				].join("\n"),
			),
		).toBe(
			'<p>[P4] Here are the links:</p><p><a href="https://example.com/app/example-org/projects/p1/stories/s1?tab=a&amp;b=1">F-12 · Export</a>.<br>• <a href="https://example.com/app/example-org/projects/p1?tab=coding-instructions">Coding instructions</a></p>',
		);
	});

	it("links a title line to the address alone on the next line", () => {
		expect(
			parlumeChatHtml(
				[
					"[P1] Project pages:",
					"Overview",
					"https://example.com/app/example-org/projects/p1?tab=overview",
					"Meeting Digest",
					"• https://example.com/app/example-org/projects/p1?tab=meeting-digest",
				].join("\n"),
			),
		).toBe(
			'<p>[P1] Project pages:<br><a href="https://example.com/app/example-org/projects/p1?tab=overview">Overview</a><br><a href="https://example.com/app/example-org/projects/p1?tab=meeting-digest">Meeting Digest</a></p>',
		);
	});

	// "[P8] Project coding instructions:" over its address showed the raw,
	// shortened address instead of a titled link.
	it("titles the one address under a line ending in a colon, without the colon", () => {
		expect(
			parlumeChatHtml(
				[
					"[P8] Project coding instructions:",
					"https://example.com/app/example-org/projects/p1?tab=coding-instructions",
					"Ask me for any other page.",
				].join("\n"),
			),
		).toBe(
			'<p>[P8] <a href="https://example.com/app/example-org/projects/p1?tab=coding-instructions">Project coding instructions</a><br>Ask me for any other page.</p>',
		);
		expect(parlumeChatHtml("Roadmap:\nhttps://example.com/r")).toBe(
			'<p><a href="https://example.com/r">Roadmap</a></p>',
		);
	});

	// On staging the agent wrote a blank line between the colon line and its
	// address, so the two sat in separate paragraphs and the address showed raw.
	it("titles the one address a blank line below a line ending in a colon", () => {
		expect(
			parlumeChatHtml(
				"[P15] Project coding instructions:\n\nhttps://example.com/p1?tab=coding-instructions",
			),
		).toBe(
			'<p>[P15] <a href="https://example.com/p1?tab=coding-instructions">Project coding instructions</a></p>',
		);
		expect(
			parlumeChatHtml(
				"Roadmap:\n\nhttps://example.com/r\n\nAsk me for any other page.",
			),
		).toBe(
			'<p><a href="https://example.com/r">Roadmap</a></p><p>Ask me for any other page.</p>',
		);
	});

	it("does not title the first of several addresses, each a blank line apart", () => {
		expect(
			parlumeChatHtml(
				"Here are the pages:\n\nhttps://example.com/a\n\nhttps://example.com/b",
			),
		).toBe(
			'<p>Here are the pages:</p><p><a href="https://example.com/a">example.com/a</a></p><p><a href="https://example.com/b">example.com/b</a></p>',
		);
	});

	it.each([
		[
			"an introduction to several addresses",
			"Here are the pages:\nhttps://example.com/a\nhttps://example.com/b",
			'<p>Here are the pages:<br><a href="https://example.com/a">example.com/a</a><br><a href="https://example.com/b">example.com/b</a></p>',
		],
		[
			"an introduction to a list",
			"Here are the pages:\nhttps://example.com/a\n• Roadmap",
			'<p>Here are the pages:<br><a href="https://example.com/a">example.com/a</a><br>• Roadmap</p>',
		],
		[
			"a sentence",
			"The roadmap is ready.\nhttps://example.com/r",
			'<p>The roadmap is ready.<br><a href="https://example.com/r">example.com/r</a></p>',
		],
		[
			"a list item with its own address",
			"• Docs: https://example.com/d\nhttps://example.com/e",
			'<p>• <a href="https://example.com/d">Docs</a><br><a href="https://example.com/e">example.com/e</a></p>',
		],
		[
			"a title whose next line holds more than an address",
			"Overview\nhttps://example.com/o is the page",
			'<p>Overview<br><a href="https://example.com/o">example.com/o</a> is the page</p>',
		],
	])("does not join %s with the next line's address", (_, text, html) => {
		expect(parlumeChatHtml(text)).toBe(html);
	});

	it("keeps the ellipsis of a shortened post out of the address", () => {
		expect(
			parlumeChatHtml(
				[
					"Release Notes: https://example.com/app/example-org/projects/p1?tab=release-notes…",
					"https://example.com/p?tab=release-notes…",
					"See https://example.com/p?tab=digest… and more.",
				].join("\n"),
			),
		).toBe(
			'<p><a href="https://example.com/app/example-org/projects/p1?tab=release-notes">Release Notes</a>…<br><a href="https://example.com/p?tab=release-notes">example.com/p</a>…<br>See <a href="https://example.com/p?tab=digest">example.com/p</a>… and more.</p>',
		);
	});

	it("keeps a closing bracket and full stop out of the address", () => {
		expect(parlumeChatHtml("(see https://example.com/p).")).toBe(
			'<p>(see <a href="https://example.com/p">example.com/p</a>).</p>',
		);
	});

	it("makes a Markdown link a link with its label", () => {
		expect(
			parlumeChatHtml(
				"[P5] See the [Azure DevOps repository](https://example.com/repo?a=1&b=2).",
			),
		).toBe(
			'<p>[P5] See the <a href="https://example.com/repo?a=1&amp;b=2">Azure DevOps repository</a>.</p>',
		);
	});

	it("labels a bare address with its host and path, not its query", () => {
		expect(
			parlumeChatHtml(
				"It is in https://example.com/app/example-org/projects/p1/stories/s1?tab=a&b=1 now.",
			),
		).toBe(
			'<p>It is in <a href="https://example.com/app/example-org/projects/p1/stories/s1?tab=a&amp;b=1">example.com/app/example-org/projects/p1/stories…</a> now.</p>',
		);
	});

	it("shows Markdown headings and emphasis as bold and italics, never as symbols", () => {
		const html = parlumeChatHtml(
			"## Release plan\n**F-12** ships *Friday*, see `docs`.",
		);

		expect(html).toBe(
			"<p><b>Release plan</b><br><b>F-12</b> ships <i>Friday</i>, see docs.</p>",
		);
		expect(html.replace(ALLOWED_TAGS, "")).not.toMatch(/[*#`]|\]\(/);
	});

	it("opens a long first paragraph with its first sentence as a lead line", () => {
		const rest =
			"It covers the export, the import and the roadmap view. ".repeat(4);

		expect(parlumeChatHtml(`[P2] F-12 is on track. ${rest}`.trim())).toBe(
			`<p>[P2] F-12 is on track.</p><p>${rest.trim()}</p>`,
		);
	});

	it("escapes text and keeps only the tags Attendee documents for Teams", () => {
		const html = parlumeChatHtml(
			'[P3] Use <b> & keep a > b\n<script>alert("x")</script>',
		);

		expect(html).toBe(
			'<p>[P3] Use &lt;b&gt; &amp; keep a &gt; b<br>&lt;script&gt;alert("x")&lt;/script&gt;</p>',
		);
		expect(html.replace(ALLOWED_TAGS, "")).not.toContain("<");
	});

	it("drops the links rather than exceed what Attendee accepts", () => {
		// 270 short addresses fit the 4,096 characters formatted, but linked
		// they would pass Attendee's 10,000.
		const url = "https://e.co/a";

		const html = parlumeChatHtml(
			Array.from({ length: 270 }, () => url).join("\n"),
		);

		expect(html.length).toBeLessThanOrEqual(10_000);
		expect(html).not.toContain("<a ");
		expect(html).toContain(`${url}<br>`);
	});

	it("renders a proposal as the bridge posts it: tag first, bold label, Confirm and Dismiss as links", () => {
		const confirmUrl =
			"https://example.com/app/example-org/projects/p1/parlume/actions/a1";
		const dismissUrl = `${confirmUrl}?intent=dismiss`;
		const message = [
			"[P8] **Proposed change** · not made yet",
			"Create feature “Export to CSV” in Example Project",
			"Asked by Alex: “create a feature called Export to CSV”",
			"Priority: High",
			`[Confirm in Fabric](${confirmUrl}) · [Dismiss](${dismissUrl})`,
			"Only a signed-in project member can confirm. Open for 24 hours.",
		].join("\n");

		const html = parlumeChatHtml(message);

		expect(message.length).toBeLessThan(1_500);
		expect(html.startsWith("<p>[P8] <b>Proposed change</b>")).toBe(true);
		expect(html).toContain(
			`<a href="${confirmUrl}">Confirm in Fabric</a> · <a href="${dismissUrl}">Dismiss</a>`,
		);
		expect(html.match(/<a /g)).toHaveLength(2);
		expect(html.replace(ALLOWED_TAGS, "")).not.toMatch(/[<>*]/);
	});

	it("renders the go-on-a-proposal line with a link whose label never starts with a tag", () => {
		const confirmUrl =
			"https://example.com/app/example-org/projects/p1/parlume/actions/a1";

		expect(
			parlumeChatHtml(
				`[P9] P8 is a proposed change. A signed-in member confirms it in Fabric: [Confirm P8 in Fabric](${confirmUrl})`,
			),
		).toBe(
			`<p>[P9] P8 is a proposed change. A signed-in member confirms it in Fabric: <a href="${confirmUrl}">Confirm P8 in Fabric</a></p>`,
		);
	});

	it("cuts escaped text to what Attendee accepts, never inside an entity", () => {
		const html = parlumeChatHtml(`"quoted" ${"&".repeat(4_000)}`);

		expect(html.length).toBeLessThanOrEqual(10_000);
		expect(html.startsWith('<p>"quoted" &amp;')).toBe(true);
		expect(html.endsWith("&amp;</p>")).toBe(true);
	});
});
