import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
	CARDS_LANGUAGE,
	CARDS_LIMITS,
	CARDS_RULE,
	type CardsParseResult,
	COLUMNS_LANGUAGE,
	COLUMNS_LIMITS,
	COLUMNS_RULE,
	type ColumnsParseResult,
	type InlineSegment,
	parseCards,
	parseColumns,
	parseInlineMarks,
} from "../lib/proposal-artifact/proposal-blocks";

const lines = (...parts: string[]) => parts.join("\n");

/** One segment, unmarked unless `marks` says otherwise. */
const seg = (
	text: string,
	marks: Partial<Omit<InlineSegment, "text">> = {},
): InlineSegment => ({
	text,
	bold: false,
	italic: false,
	code: false,
	...marks,
});

const plain = (text: string) => [seg(text)];

function reasonOf(result: CardsParseResult | ColumnsParseResult): string {
	if (result.ok) {
		throw new Error("expected the block to be refused");
	}
	return result.reason;
}

const ROUTE_CARD = lines(
	"01",
	"**Route planning**",
	"Plans each day's stops before the first truck leaves.",
);
const PILOT_CARD = lines("Pilot", "Three depots for twelve weeks.");
const HARBOR_CARD = lines(
	"Partner",
	"**Example Harbor Co**",
	"Runs the depots.",
);

/** `count` cards, each a label and a line of text. */
const cards = (count: number) =>
	Array.from({ length: count }, (_, index) =>
		lines(`Step ${index + 1}`, `Text for step ${index + 1}.`),
	).join("\n\n");

describe("parseInlineMarks", () => {
	it("reads bold, both italic forms and inline code as marks", () => {
		expect(
			parseInlineMarks("**bold** and *one* or _two_ with `code`"),
		).toEqual([
			seg("bold", { bold: true }),
			seg(" and "),
			seg("one", { italic: true }),
			seg(" or "),
			seg("two", { italic: true }),
			seg(" with "),
			seg("code", { code: true }),
		]);
	});

	it("combines nested marks", () => {
		expect(parseInlineMarks("***both***")).toEqual([
			seg("both", { bold: true, italic: true }),
		]);
		expect(parseInlineMarks("**bold *nested* bold**")).toEqual([
			seg("bold ", { bold: true }),
			seg("nested", { bold: true, italic: true }),
			seg(" bold", { bold: true }),
		]);
	});

	it("keeps a link's text, with its marks, and drops its destination", () => {
		expect(
			parseInlineMarks(
				"See [the **route** plan](https://example.com/plan).",
			),
		).toEqual([
			seg("See the "),
			seg("route", { bold: true }),
			seg(" plan."),
		]);
	});

	it("keeps an inline code span's text as code, not as marks", () => {
		expect(parseInlineMarks("`**raw**`")).toEqual([
			seg("**raw**", { code: true }),
		]);
	});

	it("keeps text CommonMark does not read as a mark", () => {
		for (const text of [
			"an unclosed ** stays",
			"order_id and customer_id",
			"2 * 3 * 4",
		]) {
			expect(parseInlineMarks(text)).toEqual(plain(text));
		}
	});

	it("decodes an escaped asterisk and entities", () => {
		expect(parseInlineMarks("\\*not italic\\*")).toEqual(
			plain("*not italic*"),
		);
		expect(parseInlineMarks("Fish &amp; chips")).toEqual(
			plain("Fish & chips"),
		);
	});

	it("keeps raw HTML, images and strikethrough as typed", () => {
		expect(parseInlineMarks("<b>bold</b> text")).toEqual(
			plain("<b>bold</b> text"),
		);
		expect(parseInlineMarks("![Depot map](map.png) here")).toEqual(
			plain("![Depot map](map.png) here"),
		);
		expect(parseInlineMarks("~~gone~~ now")).toEqual(plain("~~gone~~ now"));
		expect(parseInlineMarks("**<i>x</i>**")).toEqual([
			seg("<i>x</i>", { bold: true }),
		]);
	});

	it("reads line breaks as one space and trims the run", () => {
		expect(parseInlineMarks("  first line\n  **second** line  ")).toEqual([
			seg("first line "),
			seg("second", { bold: true }),
			seg(" line"),
		]);
	});

	it("reads a leading list marker, heading, quote or rule as text, as written", () => {
		for (const text of [
			"1. Today",
			"10) Tenth",
			"2024. A year",
			"+ Pros",
			"- Title",
			"* Starred",
			"- [ ] A task",
			"# A heading",
			"> a quote",
			"---",
			"***",
			"___",
			"- - -",
		]) {
			expect(parseInlineMarks(text)).toEqual(plain(text));
		}
	});

	it("keeps the marks after a leading block marker", () => {
		expect(parseInlineMarks("1. **first** step")).toEqual([
			seg("1. "),
			seg("first", { bold: true }),
			seg(" step"),
		]);
		expect(parseInlineMarks("> *quoted* `code`")).toEqual([
			seg("> "),
			seg("quoted", { italic: true }),
			seg(" "),
			seg("code", { code: true }),
		]);
		expect(parseInlineMarks("# ~~gone~~")).toEqual(plain("# ~~gone~~"));
	});

	it("leaves text that only starts like a marker as it is", () => {
		for (const text of ["1.5 million", "#hashtag", "-5 degrees"]) {
			expect(parseInlineMarks(text)).toEqual(plain(text));
		}
		expect(parseInlineMarks("**bold** start")).toEqual([
			seg("bold", { bold: true }),
			seg(" start"),
		]);
	});

	it("refuses empty text and a run Markdown still reads as another block", () => {
		for (const text of [
			"",
			"   ",
			"```ts",
			"<div>Depot</div>",
			"[map]: https://example.com/map",
		]) {
			expect(parseInlineMarks(text)).toBeNull();
		}
	});
});

describe("parseCards", () => {
	it("names the fence language", () => {
		expect(CARDS_LANGUAGE).toBe("cards");
	});

	it("parses a card with a label and text", () => {
		expect(parseCards(PILOT_CARD)).toEqual({
			ok: true,
			visualId: null,
			items: [
				{
					label: "Pilot",
					title: null,
					text: plain("Three depots for twelve weeks."),
				},
			],
		});
	});

	it("parses a card with a label, title and text, the title without its bold", () => {
		expect(parseCards(ROUTE_CARD)).toEqual({
			ok: true,
			visualId: null,
			items: [
				{
					label: "01",
					title: plain("Route planning"),
					text: plain(
						"Plans each day's stops before the first truck leaves.",
					),
				},
			],
		});
	});

	it("parses a card with a label and a title only", () => {
		const result = parseCards(lines("Partner", "**Example Harbor Co**"));
		expect(result.ok && result.items).toEqual([
			{ label: "Partner", title: plain("Example Harbor Co"), text: null },
		]);
	});

	it("keeps the marks inside a title", () => {
		const result = parseCards(lines("02", "**Route *planning***"));
		expect(result.ok && result.items[0]?.title).toEqual([
			seg("Route "),
			seg("planning", { italic: true }),
		]);
	});

	it("keeps the label literal, Markdown and all", () => {
		const result = parseCards(lines("*Risk* `01` <b>", "Text."));
		expect(result.ok && result.items[0]?.label).toBe("*Risk* `01` <b>");
	});

	it("joins the text's lines with a space before reading its marks", () => {
		const result = parseCards(
			lines(
				"Pilot",
				"Three depots for **twelve",
				"weeks**, then a review.",
			),
		);
		expect(result.ok && result.items[0]?.text).toEqual([
			seg("Three depots for "),
			seg("twelve weeks", { bold: true }),
			seg(", then a review."),
		]);
	});

	it("reads a bold line after the title as text", () => {
		const result = parseCards(lines("03", "**Title**", "**Also bold**"));
		expect(result.ok && result.items[0]).toEqual({
			label: "03",
			title: plain("Title"),
			text: [seg("Also bold", { bold: true })],
		});
	});

	it("reads a line with two bold runs as text, not a title", () => {
		const result = parseCards(lines("04", "**Route** and **depots**"));
		expect(result.ok && result.items[0]).toEqual({
			label: "04",
			title: null,
			text: [
				seg("Route", { bold: true }),
				seg(" and "),
				seg("depots", { bold: true }),
			],
		});
	});

	it("takes an underscore bold line as a title too", () => {
		const result = parseCards(lines("05", "__Route planning__"));
		expect(result.ok && result.items[0]?.title).toEqual(
			plain("Route planning"),
		);
	});

	it("reads a bold and italic line after the label as text, not a title", () => {
		const result = parseCards(lines("06", "***Route planning***"));
		expect(result.ok && result.items[0]).toEqual({
			label: "06",
			title: null,
			text: [seg("Route planning", { bold: true, italic: true })],
		});
	});

	it("parses three cards and eight cards, the upper bound", () => {
		const three = parseCards(
			[ROUTE_CARD, PILOT_CARD, HARBOR_CARD].join("\n\n"),
		);
		expect(three.ok && three.items.map((item) => item.label)).toEqual([
			"01",
			"Pilot",
			"Partner",
		]);
		const eight = parseCards(cards(CARDS_LIMITS.maxItems));
		expect(eight.ok && eight.items).toHaveLength(8);
	});

	it("splits cards at blank lines of any width", () => {
		const result = parseCards(lines(PILOT_CARD, "  \t", "", HARBOR_CARD));
		expect(result.ok && result.items).toHaveLength(2);
	});

	it("reads a leading fabric-visual marker as the visual id, not a card", () => {
		const result = parseCards(
			lines("%% fabric-visual: a1b2c3d4e5f6", ROUTE_CARD, "", PILOT_CARD),
		);
		expect(result.ok && result.visualId).toBe("a1b2c3d4e5f6");
		expect(result.ok && result.items.map((item) => item.label)).toEqual([
			"01",
			"Pilot",
		]);
	});

	it("parses a CRLF body the same as an LF one", () => {
		const body = lines("%% fabric-visual: a1b2c3d4e5f6", ROUTE_CARD);
		expect(parseCards(body.replace(/\n/g, "\r\n"))).toEqual(
			parseCards(body),
		);
	});

	it("refuses a nine-card block", () => {
		expect(reasonOf(parseCards(cards(9)))).toContain(CARDS_RULE);
	});

	it("refuses an empty body", () => {
		expect(reasonOf(parseCards(""))).toContain(CARDS_RULE);
		expect(reasonOf(parseCards("\n  \n"))).toContain(CARDS_RULE);
		expect(
			reasonOf(parseCards("%% fabric-visual: a1b2c3d4e5f6")),
		).toContain(CARDS_RULE);
	});

	it("refuses a label longer than 60 characters and accepts exactly 60", () => {
		const exact = "l".repeat(CARDS_LIMITS.maxLabelLength);
		expect(parseCards(lines(exact, "Text.")).ok).toBe(true);
		const result = parseCards(lines(`${exact}m`, "Text."));
		expect(reasonOf(result)).toContain("label of card 1");
	});

	it("counts characters, not UTF-16 units, toward the label limit", () => {
		const emoji = "🚚".repeat(CARDS_LIMITS.maxLabelLength);
		expect(parseCards(lines(emoji, "Text.")).ok).toBe(true);
	});

	it("refuses a title longer than 120 characters, counted without its marks", () => {
		const exact = "t".repeat(CARDS_LIMITS.maxTitleLength);
		expect(parseCards(lines("01", `**${exact}**`)).ok).toBe(true);
		expect(parseCards(lines("01", `**${exact}t**`)).ok).toBe(false);
	});

	it("refuses text longer than 600 characters, counted without its marks", () => {
		const exact = "x".repeat(CARDS_LIMITS.maxTextLength - 4);
		expect(parseCards(lines("01", `**text**${exact}`)).ok).toBe(true);
		expect(parseCards(lines("01", `**text**${exact}y`)).ok).toBe(false);
	});

	it("refuses a card with a label only", () => {
		const result = parseCards(lines(PILOT_CARD, "", "Lonely label"));
		expect(reasonOf(result)).toContain(CARDS_RULE);
		expect(reasonOf(result)).toContain("Card 2 has a label but no title");
	});

	it("refuses a card whose first line is wholly bold", () => {
		const result = parseCards(lines("**Route planning**", "Text."));
		expect(reasonOf(result)).toContain("the first line is the label");
	});

	it("refuses a misplaced marker line", () => {
		expect(
			reasonOf(
				parseCards(lines(PILOT_CARD, "%% fabric-visual: a1b2c3d4e5f6")),
			),
		).toContain("Only the first line may be the fabric-visual marker");
		expect(parseCards(lines(PILOT_CARD, "", "%% note", "Text.")).ok).toBe(
			false,
		);
	});

	it("refuses a malformed marker", () => {
		expect(
			parseCards(lines("%% fabric-visual: SHORT", ROUTE_CARD)).ok,
		).toBe(false);
	});

	it("reads card text that opens like a list, heading or quote as written", () => {
		for (const text of ["- one", "1. first", "# Heading", "> quote"]) {
			const result = parseCards(lines("01", "**Title**", text));
			expect(result.ok && result.items[0]?.text).toEqual(plain(text));
		}
		const marked = parseCards(lines("01", "1. **first** step"));
		expect(marked.ok && marked.items[0]).toEqual({
			label: "01",
			title: null,
			text: [seg("1. "), seg("first", { bold: true }), seg(" step")],
		});
	});

	it("refuses card text Markdown reads as another block", () => {
		for (const text of ["```ts", "<div>Depot</div>"]) {
			const result = parseCards(lines("01", "**Title**", text));
			expect(reasonOf(result)).toContain("The text of card 1");
		}
	});

	it("refuses a huge body before splitting it", () => {
		const huge = `${PILOT_CARD}\n${" ".repeat(CARDS_LIMITS.maxBodyLength)}`;
		expect(reasonOf(parseCards(huge))).toContain(
			String(CARDS_LIMITS.maxBodyLength),
		);
	});

	it("keeps every reason on one line", () => {
		const refused = [
			"",
			cards(9),
			lines("**Bold**", "Text."),
			"Label only",
			lines(PILOT_CARD, "%% fabric-visual: a1b2c3d4e5f6"),
			lines("01", "```ts"),
		];
		for (const body of refused) {
			expect(reasonOf(parseCards(body))).not.toMatch(/[\r\n]/);
		}
	});
});

const LEFT = lines(
	"### Today",
	"- Paper route sheets",
	"* Calls to every depot",
	"+ Weekly spreadsheets",
	"",
	"Each depot plans",
	"on its own.",
);
const RIGHT = lines(
	"### With the platform",
	"- One schedule",
	"* Live depot status",
	"+ A daily *report*",
	"",
	"Every depot reads the same plan.",
);

describe("parseColumns", () => {
	it("names the fence language", () => {
		expect(COLUMNS_LANGUAGE).toBe("columns");
	});

	it("parses headings, every bullet marker and a paragraph on both sides", () => {
		expect(parseColumns(lines(LEFT, "---", RIGHT))).toEqual({
			ok: true,
			visualId: null,
			columns: [
				[
					{ type: "heading", segments: plain("Today") },
					{
						type: "list",
						items: [
							plain("Paper route sheets"),
							plain("Calls to every depot"),
							plain("Weekly spreadsheets"),
						],
					},
					{
						type: "paragraph",
						segments: plain("Each depot plans on its own."),
					},
				],
				[
					{
						type: "heading",
						segments: plain("With the platform"),
					},
					{
						type: "list",
						items: [
							plain("One schedule"),
							plain("Live depot status"),
							[seg("A daily "), seg("report", { italic: true })],
						],
					},
					{
						type: "paragraph",
						segments: plain("Every depot reads the same plan."),
					},
				],
			],
		});
	});

	it("parses a column with two headings, one of them level four", () => {
		const result = parseColumns(
			lines(
				"### Cost",
				"Lower.",
				"#### Risk",
				"Smaller.",
				"---",
				"Text.",
			),
		);
		expect(result.ok && result.columns[0]).toEqual([
			{ type: "heading", segments: plain("Cost") },
			{ type: "paragraph", segments: plain("Lower.") },
			{ type: "heading", segments: plain("Risk") },
			{ type: "paragraph", segments: plain("Smaller.") },
		]);
	});

	it("ends a paragraph at a blank line and a list at a paragraph line", () => {
		const result = parseColumns(
			lines(
				"First.",
				"",
				"Second.",
				"- one",
				"",
				"- two",
				"Third.",
				"---",
				"Right.",
			),
		);
		expect(result.ok && result.columns[0]).toEqual([
			{ type: "paragraph", segments: plain("First.") },
			{ type: "paragraph", segments: plain("Second.") },
			{ type: "list", items: [plain("one"), plain("two")] },
			{ type: "paragraph", segments: plain("Third.") },
		]);
	});

	it("drops a heading's closing hashes", () => {
		const result = parseColumns(lines("### Today ###", "---", "Text."));
		expect(result.ok && result.columns[0]).toEqual([
			{ type: "heading", segments: plain("Today") },
		]);
	});

	it("reads a heading or bullet that opens like a list marker as written", () => {
		const result = parseColumns(
			lines(
				"### 1. **Today**",
				"- 1. Paper route sheets",
				"- > Calls to every depot",
				"---",
				"#### + Pros",
				"Text.",
			),
		);
		expect(result.ok && result.columns).toEqual([
			[
				{
					type: "heading",
					segments: [seg("1. "), seg("Today", { bold: true })],
				},
				{
					type: "list",
					items: [
						plain("1. Paper route sheets"),
						plain("> Calls to every depot"),
					],
				},
			],
			[
				{ type: "heading", segments: plain("+ Pros") },
				{ type: "paragraph", segments: plain("Text.") },
			],
		]);
	});

	it("reads a leading fabric-visual marker as the visual id", () => {
		const result = parseColumns(
			lines("%% fabric-visual: a1b2c3d4e5f6", LEFT, "---", RIGHT),
		);
		expect(result.ok && result.visualId).toBe("a1b2c3d4e5f6");
		expect(result.ok && result.columns[0]).toHaveLength(3);
	});

	it("parses a CRLF body the same as an LF one", () => {
		const body = lines(LEFT, "---", RIGHT);
		expect(parseColumns(body.replace(/\n/g, "\r\n"))).toEqual(
			parseColumns(body),
		);
	});

	it("refuses a body without a --- line", () => {
		expect(reasonOf(parseColumns(LEFT))).toContain(COLUMNS_RULE);
	});

	it("refuses two --- lines", () => {
		const reason = reasonOf(
			parseColumns(lines(LEFT, "---", RIGHT, "---", "More.")),
		);
		expect(reason).toContain("more than one --- line");
	});

	it("refuses an empty side", () => {
		expect(reasonOf(parseColumns(lines("---", RIGHT)))).toContain(
			"The left column is empty.",
		);
		expect(reasonOf(parseColumns(lines(LEFT, "---", "", "  ")))).toContain(
			"The right column is empty.",
		);
	});

	it("refuses numbered list items", () => {
		for (const line of ["1. First", "10. Tenth", "1) First"]) {
			const reason = reasonOf(
				parseColumns(lines(LEFT, line, "---", RIGHT)),
			);
			expect(reason).toContain(COLUMNS_RULE);
			expect(reason).toContain("numbered list item");
		}
	});

	it("refuses an indented bullet", () => {
		const reason = reasonOf(
			parseColumns(lines("- Depots", "  - Harbor depot", "---", RIGHT)),
		);
		expect(reason).toContain("indented bullet");
	});

	it("refuses a table line, a quote, an image and a nested fence", () => {
		for (const [line, kind] of [
			["| Depot | Trucks |", "table row"],
			["> A quote", "quote"],
			["![Depot map](map.png)", "image"],
			["```ts", "code fence"],
			["~~~", "code fence"],
		] as const) {
			const reason = reasonOf(
				parseColumns(lines(LEFT, line, "---", RIGHT)),
			);
			expect(reason).toContain(COLUMNS_RULE);
			expect(reason).toContain(kind);
		}
	});

	it("refuses headings of other levels", () => {
		for (const line of [
			"# Title",
			"## Section",
			"##### Small",
			"###### Smaller",
		]) {
			const level = line.indexOf(" ");
			expect(reasonOf(parseColumns(lines(line, "---", RIGHT)))).toContain(
				`Line 1 is a level ${level} heading.`,
			);
		}
	});

	it("refuses a heading or bullet with no text", () => {
		expect(parseColumns(lines("###", "---", RIGHT)).ok).toBe(false);
		expect(parseColumns(lines("-", "---", RIGHT)).ok).toBe(false);
	});

	it("refuses a misplaced marker line", () => {
		expect(
			reasonOf(
				parseColumns(
					lines(LEFT, "---", "%% fabric-visual: a1b2c3d4e5f6", RIGHT),
				),
			),
		).toContain("Only the first line may be the fabric-visual marker");
	});

	it("refuses more than 20 bullets a side and accepts exactly 20", () => {
		const bullets = (count: number) =>
			Array.from({ length: count }, (_, index) => `- Item ${index + 1}`);
		expect(
			parseColumns(
				lines(
					...bullets(COLUMNS_LIMITS.maxBulletsPerColumn),
					"---",
					"Text.",
				),
			).ok,
		).toBe(true);
		// Split across two lists, still counted together.
		const split = bullets(COLUMNS_LIMITS.maxBulletsPerColumn + 1);
		split.splice(10, 0, "A paragraph between.");
		expect(
			reasonOf(parseColumns(lines(...split, "---", "Text."))),
		).toContain("more than 20 bullets");
	});

	it("refuses a heading, bullet or paragraph over its length", () => {
		const over = (limit: number) => "x".repeat(limit + 1);
		expect(
			parseColumns(
				lines(
					`### ${over(COLUMNS_LIMITS.maxHeadingLength)}`,
					"---",
					"Text.",
				),
			).ok,
		).toBe(false);
		expect(
			parseColumns(
				lines(
					`- ${over(COLUMNS_LIMITS.maxBulletLength)}`,
					"---",
					"Text.",
				),
			).ok,
		).toBe(false);
		expect(
			parseColumns(
				lines(over(COLUMNS_LIMITS.maxParagraphLength), "---", "Text."),
			).ok,
		).toBe(false);
		expect(
			parseColumns(
				lines(
					"x".repeat(COLUMNS_LIMITS.maxParagraphLength),
					"---",
					"Text.",
				),
			).ok,
		).toBe(true);
	});

	it("refuses a huge body before splitting it", () => {
		const huge = `${LEFT}\n---\n${RIGHT}\n${" ".repeat(COLUMNS_LIMITS.maxBodyLength)}`;
		expect(reasonOf(parseColumns(huge))).toContain(
			String(COLUMNS_LIMITS.maxBodyLength),
		);
	});

	it("keeps every reason on one line", () => {
		const refused = [
			LEFT,
			lines("---", RIGHT),
			lines("1. First", "---", RIGHT),
			lines("- a", "  - b", "---", RIGHT),
			lines("## Section", "---", RIGHT),
		];
		for (const body of refused) {
			expect(reasonOf(parseColumns(body))).not.toMatch(/[\r\n]/);
		}
	});
});

describe("module boundaries", () => {
	it("imports no Node built-in", () => {
		const source = readFileSync(
			new URL(
				"../lib/proposal-artifact/proposal-blocks.ts",
				import.meta.url,
			),
			"utf8",
		);

		expect(source).not.toMatch(/from\s+["']node:/);
		expect(source).not.toMatch(/from\s+["'](?:fs|path|crypto|os)["']/);
	});
});
