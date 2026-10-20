import { readFileSync } from "node:fs";
import type { Nodes } from "mdast";
import { describe, expect, it } from "vitest";
import { parseMarkdownAst } from "../lib/proposal-artifact/markdown-ast";
import {
	cutReportText,
	REPORT_CITATION_SCAN_MAX_MARKERS,
	REPORT_MAX_BRACKET_WALK,
	REPORT_MAX_LAZY_LINES,
	REPORT_MAX_LINE_CODE_UNITS,
	REPORT_MAX_NESTING,
	REPORT_MAX_PARAGRAPH_ANGLE_BRACKETS,
	REPORT_MAX_PARAGRAPH_BRACKETS,
	REPORT_MAX_PARAGRAPH_DELIMITERS,
	REPORT_MAX_PUNCTUATION_RUN,
	REPORT_MAX_TABLE_CELLS,
	REPORT_MAX_TABLE_ROWS,
	REPORT_MAX_TEXT_JOIN_SHIFT,
	REPORT_MAX_TOTAL_BLOCK_LINES,
	REPORT_MAX_TOTAL_LINES,
	REPORT_MAX_TOTAL_TABLE_ROWS,
	REPORT_TEXT_MAX_CODE_UNITS,
	type ReportFenceState,
	reportFenceLine,
	reportTextNeedsPlainText,
	scanReportCitationsLinear,
	splitReportLines,
} from "../lib/proposal-artifact/report-text";

const lines = (...parts: string[]) => parts.join("\n");

/** `value` and how long `run` took, in milliseconds. */
function timed<T>(run: () => T): { value: T; ms: number } {
	const started = performance.now();
	const value = run();
	return { value, ms: performance.now() - started };
}

/** A paragraph of exactly `size` code units. */
const paragraph = (index: number, size = 98) =>
	`Paragraph ${index} about the example rollout.`
		.padEnd(size, " x")
		.slice(0, size);

const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff;

/** A table with `rows` rows (header included) of `cells` cells each. */
function table(rows: number, cells: number): string {
	const row = (label: string) =>
		`| ${Array.from({ length: cells }, (_, i) => `${label}${i}`).join(" | ")} |`;
	return lines(
		row("h"),
		`|${"---|".repeat(cells)}`,
		...Array.from({ length: rows - 1 }, (_, i) => row(`r${i}c`)),
	);
}

/** `unit` repeated into lines of about 3,000 code units, 60,000 in all, with no blank line. */
const unclosedRun = (unit: string) =>
	Array.from({ length: 20 }, () =>
		unit.repeat(Math.floor(3_000 / unit.length)),
	).join("\n");

/** 80 emphasis delimiters: fewer than a paragraph may hold, but three lines of it are more. */
const heavy = "_a_ ".repeat(40);

/** `text` cut into lines of 3,000 code units, all one paragraph. */
function wrapLines(text: string): string {
	const out: string[] = [];
	for (let i = 0; i < text.length; i += 3_000) {
		out.push(text.slice(i, i + 3_000));
	}
	return out.join("\n");
}

/** `count` code units of short words, the most walks per code unit. */
const words = (count: number) =>
	"a ".repeat(Math.ceil(count / 2)).slice(0, count);

/** 15 lines, each a bare URL with `path` after it, then a citation. */
const bareUrlLines = (path: string) =>
	Array.from({ length: 15 }, () => `See www.example.com/${path}x [S1]`).join(
		"\n",
	);

describe("report text limits", () => {
	it("keeps the agreed thresholds", () => {
		expect(REPORT_TEXT_MAX_CODE_UNITS).toBe(60_000);
		expect(REPORT_CITATION_SCAN_MAX_MARKERS).toBe(200);
		expect(REPORT_MAX_NESTING).toBe(8);
		expect(REPORT_MAX_TABLE_ROWS).toBe(100);
		expect(REPORT_MAX_TABLE_CELLS).toBe(12);
		expect(REPORT_MAX_LINE_CODE_UNITS).toBe(4_000);
		expect(REPORT_MAX_PARAGRAPH_DELIMITERS).toBe(200);
		expect(REPORT_MAX_PARAGRAPH_BRACKETS).toBe(500);
		expect(REPORT_MAX_PARAGRAPH_ANGLE_BRACKETS).toBe(20);
		expect(REPORT_MAX_BRACKET_WALK).toBe(4_000_000);
		expect(REPORT_MAX_TOTAL_TABLE_ROWS).toBe(300);
		expect(REPORT_MAX_TOTAL_BLOCK_LINES).toBe(1_000);
		expect(REPORT_MAX_LAZY_LINES).toBe(300);
		expect(REPORT_MAX_PUNCTUATION_RUN).toBe(32);
		expect(REPORT_MAX_TOTAL_LINES).toBe(3_000);
		expect(REPORT_MAX_TEXT_JOIN_SHIFT).toBe(30_000_000);
	});

	it("imports no Markdown parser", () => {
		const source = readFileSync(
			new URL("../lib/proposal-artifact/report-text.ts", import.meta.url),
			"utf8",
		);
		const imports = [...source.matchAll(/from\s+"([^"]+)"/g)].map(
			(match) => match[1],
		);
		expect(imports).toEqual(["../cut-at-code-units"]);
	});
});

describe("cutReportText", () => {
	it("returns text that fits unchanged", () => {
		const text = "# Findings\n\nThe example rollout is on track.  \n";
		expect(cutReportText(text)).toEqual({ text, truncated: false });
		expect(cutReportText("")).toEqual({ text: "", truncated: false });
	});

	it("cuts at the last blank line before the cap", () => {
		const paragraphs = Array.from({ length: 700 }, (_, i) => paragraph(i));
		const text = paragraphs.join("\n\n");
		expect(text.length).toBeGreaterThan(69_000);

		const result = cutReportText(text);

		// Each paragraph and its blank line take 100 code units, so the blank
		// line after paragraph 599 starts at 59,999 and the next at 60,099.
		expect(result).toEqual({
			text: paragraphs.slice(0, 600).join("\n\n"),
			truncated: true,
		});
		expect(result.text.length).toBeLessThanOrEqual(
			REPORT_TEXT_MAX_CODE_UNITS,
		);
	});

	it("moves the cut before a fence still open at the cap", () => {
		const before = Array.from({ length: 590 }, (_, i) => paragraph(i)).join(
			"\n\n",
		);
		const code = Array.from({ length: 80 }, (_, i) =>
			i % 5 === 4 ? "" : `const value${i} = compute(${i});`,
		);
		const fence = lines("```ts", ...code, "```");
		const after = Array.from({ length: 100 }, (_, i) => paragraph(i)).join(
			"\n\n",
		);
		const text = [
			before,
			"Lead-in line for the snippet:",
			fence,
			after,
		].join("\n\n");
		const fenceStart = text.indexOf("```ts");
		expect(fenceStart).toBeLessThan(REPORT_TEXT_MAX_CODE_UNITS);
		expect(text.indexOf("```", fenceStart + 3)).toBeGreaterThan(
			REPORT_TEXT_MAX_CODE_UNITS,
		);

		const result = cutReportText(text);

		expect(result).toEqual({
			text: `${before}\n\nLead-in line for the snippet:`,
			truncated: true,
		});
	});

	it("cuts before an open fence's opening line when no blank line precedes it", () => {
		const text = lines(
			"Lead-in line for the snippet:",
			"~~~~",
			...Array.from({ length: 4_000 }, (_, i) => `row ${i}`),
			"",
			"~~~~",
		);

		expect(cutReportText(text, 1_000)).toEqual({
			text: "Lead-in line for the snippet:",
			truncated: true,
		});
	});

	it("ignores blank lines inside a fence that closes before the cap", () => {
		const text = lines(
			"First paragraph.",
			"",
			"```",
			"code",
			"",
			"more code",
			"```",
			"Tail line that runs past the cap.",
		);
		const cap = text.indexOf("Tail") + 10;

		expect(cutReportText(text, cap)).toEqual({
			text: "First paragraph.",
			truncated: true,
		});
	});

	it("reads CRLF and CR line endings", () => {
		expect(
			cutReportText("First paragraph.\r\n\r\nSecond paragraph.", 25),
		).toEqual({ text: "First paragraph.", truncated: true });
		expect(
			cutReportText("First paragraph.\r\rSecond paragraph.", 25),
		).toEqual({ text: "First paragraph.", truncated: true });
	});

	it("cuts hard, keeping surrogate pairs whole, when there is no blank line", () => {
		const text = `${"a".repeat(59_999)}𝒜${"b".repeat(10_000)}`;
		// The astral character's halves sit at 59,999 and 60,000.
		expect(isHighSurrogate(text.charCodeAt(59_999))).toBe(true);

		const result = cutReportText(text);

		expect(result).toEqual({ text: "a".repeat(59_999), truncated: true });
		expect(
			isHighSurrogate(result.text.charCodeAt(result.text.length - 1)),
		).toBe(false);
	});

	it("drops trailing whitespace from a hard cut", () => {
		expect(cutReportText(`words${" ".repeat(20)}more words`, 15)).toEqual({
			text: "words",
			truncated: true,
		});
	});

	it("never returns more than the cap", () => {
		const text = lines(
			"# Report 𝒜𝒜𝒜",
			"",
			"```",
			"code 𝒜",
			"",
			"```",
			"Body text 𝒜 with more words.",
			"",
			"~~~",
			"open fence",
			"",
			"never closed",
		);
		for (let cap = 0; cap <= text.length; cap++) {
			const result = cutReportText(text, cap);
			expect(result.text.length).toBeLessThanOrEqual(cap);
			expect(result.truncated).toBe(cap < text.length);
			expect(text.startsWith(result.text)).toBe(true);
			if (result.text.length > 0) {
				expect(
					isHighSurrogate(
						result.text.charCodeAt(result.text.length - 1),
					),
				).toBe(false);
			}
		}
	});
});

describe("reportTextNeedsPlainText", () => {
	const ordinaryReport = lines(
		"# Analysis of the Example Org proposal",
		"",
		"## Findings",
		"",
		"The scope is **mostly** consistent with the brief [S1], and the _timeline_",
		"holds if the data migration starts in week two [S2].",
		"",
		"- Delivery",
		"  - Phases",
		"    - Discovery takes two weeks [S3]",
		"1. First step",
		"2. Second step",
		"",
		"> A quoted note from the brief.",
		"> > A nested quote.",
		"",
		table(5, 4),
		"",
		"```sql",
		"select id, name from example_table where status = 'open';",
		"```",
		"",
		"---",
		"",
		"See [the brief](https://example.com/brief) for details.",
	);

	it("passes an ordinary report", () => {
		expect(reportTextNeedsPlainText(ordinaryReport)).toBe(false);
		expect(reportTextNeedsPlainText("")).toBe(false);
	});

	it.each([
		["10,000 `>` on one line", ">".repeat(10_000)],
		["`- ` 3,000 times on one line", "- ".repeat(3_000)],
		["a 5,000-code-unit line", "a".repeat(5_000)],
		["60,000 characters of `*a`", "*a".repeat(30_000)],
		[
			"60,000 `]` in one paragraph of short lines",
			Array.from({ length: 15 }, () => "]".repeat(3_990)).join("\n"),
		],
		[
			"a paragraph of short lines with more than 200 `*`",
			Array.from({ length: 60 }, () => "*a* *b*").join("\n"),
		],
		[
			"hostile lines after a fence opener hidden in an HTML comment",
			lines(
				"<!--",
				"```",
				"-->",
				...Array.from({ length: 15 }, () => "]".repeat(3_990)),
				"```",
			),
		],
		[
			"hostile lines after a fence opened inside a list item",
			lines(
				"- item",
				"  ```",
				"plain line",
				...Array.from({ length: 15 }, () => "*a".repeat(1_990)),
			),
		],
		[
			"60,000 characters of unclosed `<?` in one paragraph",
			unclosedRun("a <?a "),
		],
		[
			"60,000 characters of unclosed `<!--` in one paragraph",
			unclosedRun("a <!--a "),
		],
		[
			"60,000 characters of unclosed `<!A` in one paragraph",
			unclosedRun("a <!A "),
		],
		[
			"60 tables of 100 rows",
			Array.from({ length: 60 }, () => table(100, 1)).join("\n\n"),
		],
		[
			"2,500 `- a` lines",
			Array.from({ length: 2_500 }, () => "- a").join("\n"),
		],
		["30,000 lazy lines under a quote", `> a\n${"b\n".repeat(29_997)}`],
		["20,000 lazy lines under a list item", `- a\n${"b\n".repeat(20_000)}`],
		[
			"20,000 lazy lines under an ordered item",
			`1. a\n${"b\n".repeat(20_000)}`,
		],
		[
			"20,000 lazy lines in a list item continued past a blank line",
			`- a\n\n  b\n${"c\n".repeat(20_000)}`,
		],
		[
			"15 lines of a bare URL and 3,970 dots",
			bareUrlLines(".".repeat(3_970)),
		],
		[
			"15 lines of a bare URL and 3,970 question marks",
			bareUrlLines("?".repeat(3_970)),
		],
		[
			"15 lines of a bare URL and 1,320 `&a;`",
			bareUrlLines("&a;".repeat(1_320)),
		],
		["20,000 `<a` lines", "<a\n".repeat(20_000)],
		["15 lines of `<a\\.` in one paragraph", unclosedRun("<a\\.")],
		["15 lines of `a b&amp;` in one paragraph", unclosedRun("a b&amp;")],
	])("flags %s, quickly", (_label, text) => {
		const { value, ms } = timed(() => reportTextNeedsPlainText(text));
		expect(value).toBe(true);
		expect(ms).toBeLessThan(200);
	});

	it("counts container nesting along one line", () => {
		expect(reportTextNeedsPlainText("> > - * 1. text")).toBe(false);
		expect(reportTextNeedsPlainText(`${"- ".repeat(8)}x`)).toBe(false);
		expect(reportTextNeedsPlainText(`${"- ".repeat(9)}x`)).toBe(true);
		expect(reportTextNeedsPlainText(">".repeat(8))).toBe(false);
		expect(reportTextNeedsPlainText(">".repeat(9))).toBe(true);
		expect(reportTextNeedsPlainText(`${"1. ".repeat(9)}x`)).toBe(true);
		expect(reportTextNeedsPlainText(`${"1) ".repeat(9)}x`)).toBe(true);
	});

	it("counts two columns of indentation before a marker as a level", () => {
		expect(reportTextNeedsPlainText(`${" ".repeat(14)}- item`)).toBe(false);
		expect(reportTextNeedsPlainText(`${" ".repeat(16)}- item`)).toBe(true);
		expect(reportTextNeedsPlainText("\t\t\t\t- item")).toBe(true);
		// Indentation after a quote marker nests lists inside the quote.
		expect(reportTextNeedsPlainText(`>${" ".repeat(17)}- item`)).toBe(true);
		// Indentation before plain content opens nothing.
		expect(reportTextNeedsPlainText(`${" ".repeat(40)}code`)).toBe(false);
	});

	it("counts nesting built up over lines, whatever ends them", () => {
		const nested = (newline: string) =>
			Array.from(
				{ length: 10 },
				(_, depth) => `${"  ".repeat(depth)}- level ${depth}`,
			).join(newline);
		expect(reportTextNeedsPlainText(nested("\n"))).toBe(true);
		expect(reportTextNeedsPlainText(nested("\r\n"))).toBe(true);
		expect(reportTextNeedsPlainText(nested("\r"))).toBe(true);
	});

	it("does not take bold text or numbers for container markers", () => {
		expect(
			reportTextNeedsPlainText("**Bold** lead-in and 1.5 million rows."),
		).toBe(false);
		expect(reportTextNeedsPlainText(`${"1234567890. ".repeat(9)}x`)).toBe(
			false,
		);
	});

	it("limits a table to 100 rows", () => {
		const { value, ms } = timed(() =>
			reportTextNeedsPlainText(table(101, 4)),
		);
		expect(value).toBe(true);
		expect(ms).toBeLessThan(200);
		expect(reportTextNeedsPlainText(table(100, 4))).toBe(false);
	});

	it("counts table rows that carry no pipe", () => {
		const text = lines(
			table(2, 3),
			...Array.from({ length: 100 }, (_, i) => `row ${i}`),
		);
		expect(reportTextNeedsPlainText(text)).toBe(true);
	});

	it("ends a table at a blank line", () => {
		expect(
			reportTextNeedsPlainText(lines(table(60, 4), "", table(60, 4))),
		).toBe(false);
	});

	it("limits a table row to 12 cells", () => {
		expect(reportTextNeedsPlainText(table(3, 13))).toBe(true);
		expect(reportTextNeedsPlainText(table(3, 12))).toBe(false);
		const wideBodyRow = lines(table(3, 4), `| ${"c | ".repeat(13)}`);
		expect(reportTextNeedsPlainText(wideBodyRow)).toBe(true);
	});

	it("reads cells by unescaped pipes", () => {
		const escaped = lines(
			"| a | b |",
			"|---|---|",
			`| ${"x \\| ".repeat(20)} | y |`,
		);
		expect(reportTextNeedsPlainText(escaped)).toBe(false);
		const withoutOuterPipes = lines(
			Array.from({ length: 12 }, (_, i) => `h${i}`).join(" | "),
			Array.from({ length: 12 }, () => "---").join(" | "),
		);
		expect(reportTextNeedsPlainText(withoutOuterPipes)).toBe(false);
	});

	it("leaves pipes outside a table alone", () => {
		expect(reportTextNeedsPlainText(`a ${"| b ".repeat(30)}`)).toBe(false);
	});

	it("allows a line of 4,000 code units", () => {
		expect(reportTextNeedsPlainText("a".repeat(4_000))).toBe(false);
	});

	it("counts emphasis delimiters per paragraph", () => {
		const shortLines = Array.from({ length: 60 }, () => "*a* *b*");
		expect(reportTextNeedsPlainText(shortLines.join("\n\n"))).toBe(false);
		expect(reportTextNeedsPlainText("_".repeat(200))).toBe(false);
		expect(reportTextNeedsPlainText("~".repeat(201))).toBe(true);
	});

	it("ends a paragraph only at a line of spaces and tabs", () => {
		const parts = Array.from({ length: 4 }, () => "*".repeat(150));
		expect(reportTextNeedsPlainText(parts.join("\n \t\n"))).toBe(false);
		// A no-break space is content, so the paragraph runs on.
		expect(reportTextNeedsPlainText(parts.join("\n \n"))).toBe(true);
	});

	it("counts brackets per paragraph, leaving room for 200 citations", () => {
		const cited = Array.from(
			{ length: 200 },
			(_, i) => `Claim ${i} [S${(i % 40) + 1}].`,
		);
		const oneParagraph = Array.from({ length: 20 }, (_, row) =>
			cited.slice(row * 10, row * 10 + 10).join(" "),
		).join("\n");
		expect(reportTextNeedsPlainText(oneParagraph)).toBe(false);
		expect(reportTextNeedsPlainText("]".repeat(501))).toBe(true);
		expect(reportTextNeedsPlainText("[".repeat(501))).toBe(true);
	});

	it("counts `<!` and `<?` per paragraph", () => {
		expect(reportTextNeedsPlainText("<!-- a --> ".repeat(20))).toBe(false);
		expect(reportTextNeedsPlainText("<!-- a --> ".repeat(21))).toBe(true);
		expect(reportTextNeedsPlainText("<?a ".repeat(21))).toBe(true);
		expect(reportTextNeedsPlainText("<!A ".repeat(21))).toBe(true);
		const half = "a <!-- b ".repeat(15);
		expect(reportTextNeedsPlainText(lines(half, half))).toBe(true);
		expect(reportTextNeedsPlainText(lines(half, "", half))).toBe(false);
	});

	it("leaves tags, autolinks and comparisons uncounted", () => {
		const breaks = lines(
			"| Item | Note |",
			"|---|---|",
			...Array.from(
				{ length: 99 },
				(_, i) => `| Item ${i} | first<br>second<br/>third |`,
			),
		);
		expect(reportTextNeedsPlainText(breaks)).toBe(false);
		const compared = Array.from(
			{ length: 300 },
			(_, i) => `${i} < ${i + 1}, see <https://example.com/${i}>`,
		).join(" ");
		expect(reportTextNeedsPlainText(wrapLines(compared))).toBe(false);
	});

	it("limits the report's tables to 300 rows in all", () => {
		const full = Array.from({ length: 3 }, () => table(100, 4));
		expect(reportTextNeedsPlainText(full.join("\n\n"))).toBe(false);
		// A header row alone is one more row.
		expect(
			reportTextNeedsPlainText([...full, table(1, 4)].join("\n\n")),
		).toBe(true);
	});

	it("limits the report to 1,000 block-opening lines", () => {
		const items = (count: number) =>
			Array.from({ length: count }, (_, i) => `- item ${i}`).join("\n");
		expect(reportTextNeedsPlainText(items(1_000))).toBe(false);
		expect(reportTextNeedsPlainText(items(1_001))).toBe(true);

		const quotes = Array.from({ length: 1_001 }, () => "> quoted").join(
			"\n",
		);
		expect(reportTextNeedsPlainText(quotes)).toBe(true);
		const headings = Array.from(
			{ length: 1_001 },
			(_, i) => `## Part ${i}`,
		);
		expect(reportTextNeedsPlainText(headings.join("\n\n"))).toBe(true);
		expect(reportTextNeedsPlainText(headings.slice(1).join("\n\n"))).toBe(
			false,
		);
		// `#5` and `#######` are no headings.
		const hashes = Array.from({ length: 1_001 }, (_, i) =>
			i % 2 ? "#5 is next" : "####### seven",
		);
		expect(reportTextNeedsPlainText(hashes.join("\n\n"))).toBe(false);

		// Table rows count too: 300 of them and 701 items is one too many.
		const mixed = [
			...Array.from({ length: 3 }, () => table(100, 4)),
			items(701),
		].join("\n\n");
		expect(reportTextNeedsPlainText(mixed)).toBe(true);
	});
});

describe("reportTextNeedsPlainText on unbalanced brackets", () => {
	const tail = wrapLines(` ${words(6_000)}`);

	it.each([
		["an unclosed `[`", "["],
		["an unclosed `![`", "!["],
		["an unclosed footnote call", "[^1"],
		["a `]` inside code", "[`]`"],
		["an escaped `]`", "[\\]"],
		["a `]` inside an autolink", "[<https://example.com/]>"],
		["a nested pair", "[[a]"],
		["a link inside brackets", "[[a](https://example.com)"],
	])("flags %s before many words", (_label, prefix) => {
		const text = `${prefix} ${tail}`;
		const { value, ms } = timed(() => reportTextNeedsPlainText(text));
		expect(value).toBe(true);
		expect(ms).toBeLessThan(200);
	});

	it.each([
		["a citation", "[S1]"],
		["a link", "[the brief](https://example.com/brief)"],
		["a reference link", "[the brief][brief]"],
		["nested pairs", "[a [b] [c](https://example.com)]"],
		["an escaped `[`", "\\[S1"],
		["code inside brackets, balanced again", "[a] `[b]`"],
		["emphasis inside brackets", "[**Must**, _Should_]"],
	])("passes %s before many words", (_label, prefix) => {
		expect(reportTextNeedsPlainText(`${prefix} ${tail}`)).toBe(false);
	});

	it("allows about 2,800 code units after an unclosed `[`", () => {
		expect(reportTextNeedsPlainText(`[ ${words(2_600)}`)).toBe(false);
		expect(reportTextNeedsPlainText(`[ ${words(3_000)}`)).toBe(true);
		// A paragraph break or a new list item ends the walks.
		const more = wrapLines(words(30_000));
		expect(
			reportTextNeedsPlainText(lines(`[ ${words(2_000)}`, "", more)),
		).toBe(false);
		expect(
			reportTextNeedsPlainText(lines(`- [ ${words(2_000)}`, `- ${more}`)),
		).toBe(false);
		// The budget is the whole report's: five such paragraphs are too many.
		const paragraphs = (count: number) =>
			Array.from({ length: count }, () => `[ ${words(1_400)}`).join(
				"\n\n",
			);
		expect(reportTextNeedsPlainText(paragraphs(2))).toBe(false);
		expect(reportTextNeedsPlainText(paragraphs(5))).toBe(true);
	});

	it("charges each `]` its distance from the paragraph's start", () => {
		const long = wrapLines(words(50_000));
		expect(reportTextNeedsPlainText(`${long}${"]".repeat(60)}`)).toBe(
			false,
		);
		expect(reportTextNeedsPlainText(`${long}${"]".repeat(100)}`)).toBe(
			true,
		);
	});
});

describe("reportTextNeedsPlainText across list items", () => {
	const lead = (i: number) => `**Lead ${i}**: some text with a [S2] marker`;

	it("passes long tight lists with bold leads", () => {
		const list = (marker: (i: number) => string) =>
			Array.from(
				{ length: 60 },
				(_, i) => `${marker(i)} ${lead(i)}`,
			).join("\n");
		expect(reportTextNeedsPlainText(list(() => "-"))).toBe(false);
		expect(reportTextNeedsPlainText(list(() => "*"))).toBe(false);
		expect(reportTextNeedsPlainText(list(() => "+"))).toBe(false);
		expect(reportTextNeedsPlainText(list((i) => `${i + 1}.`))).toBe(false);
		expect(reportTextNeedsPlainText(list((i) => `${i + 1})`))).toBe(false);
	});

	it("restarts the counts at items nested up to three spaces deep", () => {
		const nested = Array.from({ length: 30 }, (_, i) =>
			lines(
				`- ${lead(i)}`,
				`  - ${heavy}`,
				`   1. ${heavy}`,
				`   2. ${heavy}`,
			),
		).join("\n");
		expect(reportTextNeedsPlainText(nested)).toBe(false);
		// The `<` count restarts too.
		const compared = Array.from(
			{ length: 60 },
			(_, i) => `- Option ${i}: ${"a < b, ".repeat(10)}`,
		).join("\n");
		expect(reportTextNeedsPlainText(compared)).toBe(false);
	});

	it.each([
		["`2.` under a plain line", lines(heavy, `2. ${heavy}`, `3. ${heavy}`)],
		["an empty item", lines(heavy, "*", heavy, "*", heavy)],
		[
			"a marker indented four spaces",
			lines(heavy, `    - ${heavy}`, `    - ${heavy}`),
		],
		["a marker after a tab", lines(heavy, `\t- ${heavy}`, `\t- ${heavy}`)],
		[
			"`2.` after indented code and a blank line",
			lines("    code", "", `2. ${heavy}`, `3. ${heavy}`, `4. ${heavy}`),
		],
		[
			"`2.` under text after a fence closed in a list item",
			lines(
				"- ```",
				"  1. a",
				"     ```",
				"     text",
				`  2. ${heavy}`,
				`  3. ${heavy}`,
				`  4. ${heavy}`,
			),
		],
	])(
		"does not restart the counts at %s, which the parser reads as paragraph text",
		(_label, text) => {
			// The parser does read three payload lines as one paragraph.
			const longest = Math.max(
				...inlineLineSpans(text).map(([first, last]) => last - first),
			);
			expect(longest).toBeGreaterThanOrEqual(2);

			expect(reportTextNeedsPlainText(text)).toBe(true);
		},
	);

	it.each([
		["`2)` under `1.`", lines(`1. ${heavy}`, `2) ${heavy}`, `3) ${heavy}`)],
		[
			"`2.` under a bullet",
			lines(`- ${heavy}`, `2. ${heavy}`, `3. ${heavy}`),
		],
		[
			"`2.` at another indentation",
			lines(`1. ${heavy}`, ` 2. ${heavy}`, `3. ${heavy}`),
		],
		[
			"an item four columns deeper than its parent",
			lines(
				"- x",
				"  - y",
				`    - ${heavy}`,
				`    - ${heavy}`,
				`    - ${heavy}`,
			),
		],
		[
			"items inside fenced code",
			lines("```", `- ${heavy}`, `- ${heavy}`, `- ${heavy}`, "```"),
		],
	])("keeps counting across %s, an item it cannot prove", (_label, text) => {
		expect(reportTextNeedsPlainText(text)).toBe(true);
	});

	it("never lets a parsed paragraph hold more delimiters than the limit", () => {
		// Random short reports of the lines a list restart could misread.
		// Whenever the check passes one, no paragraph or heading the parser
		// reads may span more than 200 underscores of the payload.
		const kinds: ReadonlyArray<readonly [string, boolean]> = [
			["text", true],
			["- ", true],
			["* ", true],
			["1. ", true],
			["2. ", true],
			["1) ", true],
			["2) ", true],
			["  - ", true],
			["   2. ", true],
			["    - ", true],
			["      - ", true],
			["> ", true],
			["> 2. ", true],
			["  text ", true],
			["     text ", true],
			["\t- ", true],
			["-", false],
			["*", false],
			["2.", false],
			["```", false],
			["- ```", false],
			["    code", false],
			["<!--", false],
			["-->", false],
			["# heading", false],
			["---", false],
			["", false],
			["", false],
		];
		let seed = 2_946;
		const random = (below: number) => {
			seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
			return seed % below;
		};
		let passed = 0;
		const overfull: string[] = [];
		for (let run = 0; run < 2_000; run++) {
			const picked = Array.from(
				{ length: 2 + random(9) },
				() => kinds[random(kinds.length)],
			);
			const report = picked
				.map(([prefix, payload]) =>
					payload ? `${prefix}${heavy}` : prefix,
				)
				.join("\n");
			if (reportTextNeedsPlainText(report)) {
				continue;
			}
			passed++;
			for (const [first, last] of inlineLineSpans(report)) {
				const underscores =
					picked
						.slice(first - 1, last)
						.filter(([, payload]) => payload).length * 80;
				if (underscores > REPORT_MAX_PARAGRAPH_DELIMITERS) {
					overfull.push(report);
				}
			}
		}
		expect(overfull).toEqual([]);
		// Enough reports pass for the property to say something.
		expect(passed).toBeGreaterThan(500);
	});
});

describe("reportTextNeedsPlainText on lazy continuation lines", () => {
	const lazy = (count: number) => "b\n".repeat(count);

	it.each([
		["a quote", "> a"],
		["a nested quote", "> > a"],
		["eight quotes", ">>>>>>>> a"],
		["a list item", "- a"],
		["an ordered item", "1. a"],
		["a list item in a quote", "> - a"],
	])("allows 300 lazy lines under %s", (_label, opener) => {
		expect(reportTextNeedsPlainText(`${opener}\n${lazy(300)}`)).toBe(false);
		expect(reportTextNeedsPlainText(`${opener}\n${lazy(301)}`)).toBe(true);
	});

	it("counts the lines of a list item continued past a blank line", () => {
		// `  b` continues the item, and every line after it is lazy.
		expect(
			reportTextNeedsPlainText(`- a\n\n  b\n${"c\n".repeat(299)}`),
		).toBe(false);
		expect(
			reportTextNeedsPlainText(`- a\n\n  b\n${"c\n".repeat(300)}`),
		).toBe(true);
		// A line with less indentation after a blank one closes the item.
		expect(
			reportTextNeedsPlainText(`- a\n\n b\n${"c\n".repeat(1_000)}`),
		).toBe(false);
	});

	it("restarts the count at a blank line and at a new list item", () => {
		const quoted = `> a\n${lazy(300)}`;
		expect(reportTextNeedsPlainText(`${quoted}\n${quoted}`)).toBe(false);
		const item = (marker: string) => `${marker} a\n${lazy(300)}`;
		expect(reportTextNeedsPlainText(item("-") + item("*"))).toBe(false);
		expect(reportTextNeedsPlainText(item("1.") + item("1."))).toBe(false);
	});

	it("keeps counting across a line that continues the quote", () => {
		// `> c` carries on the same paragraph, which the lines after it extend.
		expect(
			reportTextNeedsPlainText(`> a\n${lazy(200)}> c\n${lazy(200)}`),
		).toBe(true);
	});

	it("leaves lines alone when no container is open", () => {
		expect(reportTextNeedsPlainText(`a\n${lazy(2_000)}`)).toBe(false);
		// An unindented paragraph after a blank line closes the quote above it.
		expect(reportTextNeedsPlainText(`> a\n\nb\n${lazy(2_000)}`)).toBe(
			false,
		);
	});
});

describe("reportTextNeedsPlainText on punctuation runs", () => {
	const url = (path: string) => `See www.example.com/${path}x [S1]`;

	it("allows 32 characters of trailing punctuation in a row in a bare URL", () => {
		expect(reportTextNeedsPlainText(url(".".repeat(32)))).toBe(false);
		expect(reportTextNeedsPlainText(url(".".repeat(33)))).toBe(true);
		expect(reportTextNeedsPlainText(url(`!"'),.:;?]`.repeat(4)))).toBe(
			true,
		);
		// A character reference's letters carry the run on.
		expect(reportTextNeedsPlainText(url("&amp;".repeat(6)))).toBe(false);
		expect(reportTextNeedsPlainText(url("&amp;".repeat(7)))).toBe(true);
	});

	it("counts runs in a URL's domain and after a scheme, in any case", () => {
		expect(reportTextNeedsPlainText(`www.${".".repeat(32)}x`)).toBe(false);
		expect(reportTextNeedsPlainText(`www.${".".repeat(33)}x`)).toBe(true);
		expect(
			reportTextNeedsPlainText(`WWW.EXAMPLE.COM/${".".repeat(33)}x`),
		).toBe(true);
		expect(
			reportTextNeedsPlainText(
				`See https://example.com/${"?".repeat(33)}x`,
			),
		).toBe(true);
	});

	it("carries a run on across delimiters without counting them", () => {
		const dots = (count: number) =>
			`${".".repeat(10)}${"_*~".repeat(20)}${".".repeat(count)}`;
		expect(reportTextNeedsPlainText(url(dots(22)))).toBe(false);
		expect(reportTextNeedsPlainText(url(dots(23)))).toBe(true);
	});

	it("ends a run at any other character, a backslash included", () => {
		expect(reportTextNeedsPlainText(url(".a".repeat(300)))).toBe(false);
		expect(reportTextNeedsPlainText(url("\\.".repeat(300)))).toBe(false);
	});

	it("ends a bare URL at a space, a tab or a line end", () => {
		const dots = ".".repeat(30);
		expect(reportTextNeedsPlainText(url(`${dots} ${dots}`))).toBe(false);
		expect(reportTextNeedsPlainText(url(`${dots}\t${dots}`))).toBe(false);
		expect(reportTextNeedsPlainText(lines(url(dots), dots))).toBe(false);
	});

	it("leaves punctuation outside a bare URL uncounted", () => {
		expect(reportTextNeedsPlainText(`See ${".".repeat(3_000)} [S1]`)).toBe(
			false,
		);
		expect(reportTextNeedsPlainText(`See ${"?!".repeat(1_500)}`)).toBe(
			false,
		);
		// A space ends the URL before the run.
		expect(
			reportTextNeedsPlainText(
				`See www.example.com/x ${".".repeat(300)}`,
			),
		).toBe(false);
	});

	it("passes ellipses and dot leaders", () => {
		const contents = Array.from(
			{ length: 10 },
			(_, i) => `Section ${i + 1} ${".".repeat(80)} ${i + 2}`,
		);
		expect(
			reportTextNeedsPlainText(
				lines("Wait... the scope grew?!", "", ...contents),
			),
		).toBe(false);
	});
});

describe("reportTextNeedsPlainText on many lines", () => {
	/** `count` short lines, ten to a paragraph. */
	const notes = (count: number) =>
		Array.from({ length: count }, (_, i) =>
			i % 10 === 9 ? `note ${i}\n` : `note ${i}`,
		).join("\n");

	it("allows 3,000 non-blank lines", () => {
		expect(reportTextNeedsPlainText(notes(3_000))).toBe(false);
		expect(reportTextNeedsPlainText(notes(3_001))).toBe(true);
		expect(reportTextNeedsPlainText("a\n\n".repeat(3_000))).toBe(false);
		expect(reportTextNeedsPlainText("a\n\n".repeat(3_001))).toBe(true);
		// Blank lines are free.
		expect(reportTextNeedsPlainText(`${"\n".repeat(50_000)}a`)).toBe(false);
	});
});

describe("reportTextNeedsPlainText on text joins", () => {
	/** As many `unit` as fit in `size` code units. */
	const repeated = (unit: string, size: number) =>
		unit.repeat(Math.floor(size / unit.length));

	it.each([
		["an escape", "a b\\."],
		["a character reference", "a b&amp;"],
		["a code span", "a b`c`"],
		["a tag", "a b<b>"],
		["an autolink", "a b<https://example.com>"],
		["a bare email address", "a b c@example.com "],
		["a bare `www.` URL", "a b www.example.com "],
		["a bare URL with a scheme", "a b https://example.com "],
	])("charges %s the rest of its paragraph", (_label, unit) => {
		expect(
			reportTextNeedsPlainText(wrapLines(repeated(unit, 45_000))),
		).toBe(true);
		const short = Array.from({ length: 100 }, () => repeated(unit, 400));
		expect(reportTextNeedsPlainText(short.join("\n\n"))).toBe(false);
	});

	it("charges line endings the rest of their paragraph", () => {
		const line = "plain words here";
		const many = Array.from({ length: 2_900 }, () => line);
		expect(reportTextNeedsPlainText(many.join("\n"))).toBe(true);
		const tens = Array.from({ length: 290 }, () => many.slice(0, 10));
		expect(
			reportTextNeedsPlainText(
				tens.map((part) => part.join("\n")).join("\n\n"),
			),
		).toBe(false);
	});

	it("leaves room for a long paragraph of hard-wrapped prose", () => {
		const prose =
			"The example rollout keeps its pilot scope and its budget. "
				.repeat(700)
				.slice(0, 40_000);
		const wrapped = prose.match(/.{1,80}/g) ?? [];
		expect(wrapped.length).toBe(500);
		expect(reportTextNeedsPlainText(wrapped.join("\n"))).toBe(false);
	});
});

/** The first and last line (1-based) of each paragraph and heading in `markdown`. */
function inlineLineSpans(markdown: string): Array<[number, number]> {
	const spans: Array<[number, number]> = [];
	const stack: Nodes[] = [parseMarkdownAst(markdown)];
	while (stack.length > 0) {
		const node = stack.pop() as Nodes;
		if (
			(node.type === "paragraph" || node.type === "heading") &&
			node.position
		) {
			spans.push([node.position.start.line, node.position.end.line]);
		}
		if ("children" in node) {
			stack.push(...node.children);
		}
	}
	return spans;
}

describe("splitReportLines", () => {
	it("splits at LF, CRLF and CR, as the checks read lines", () => {
		expect(splitReportLines("a\r\nb\rc\nd")).toEqual(["a", "b", "c", "d"]);
		expect(splitReportLines("a\n")).toEqual(["a", ""]);
		expect(splitReportLines("\n\r")).toEqual(["", "", ""]);
		expect(splitReportLines("")).toEqual([""]);
	});
});

describe("reportFenceLine", () => {
	const backticks: ReportFenceState = { marker: "`", length: 3 };
	const tildes: ReportFenceState = { marker: "~", length: 4 };

	it("opens a fence, with its info string", () => {
		expect(reportFenceLine("```ts", null)).toEqual({
			kind: "open",
			fence: backticks,
			info: "ts",
		});
		expect(
			reportFenceLine("   ~~~~ \tjson fabric-report \t", null),
		).toEqual({
			kind: "open",
			fence: tildes,
			info: "json fabric-report",
		});
		expect(reportFenceLine("```", null)).toEqual({
			kind: "open",
			fence: backticks,
			info: "",
		});
		// A tilde fence's info string may hold backticks.
		expect(reportFenceLine("~~~ a`b", null)).toMatchObject({
			kind: "open",
			info: "a`b",
		});
	});

	it("leaves other lines outside", () => {
		expect(reportFenceLine("plain text", null)).toEqual({
			kind: "outside",
		});
		expect(reportFenceLine("``", null)).toEqual({ kind: "outside" });
		expect(reportFenceLine("``` a`b", null)).toEqual({ kind: "outside" });
		expect(reportFenceLine("```inline``` code", null)).toEqual({
			kind: "outside",
		});
		// Four spaces make indented code, not a fence.
		expect(reportFenceLine("    ```", null)).toEqual({ kind: "outside" });
		expect(reportFenceLine("- ```", null)).toEqual({ kind: "outside" });
	});

	it("closes with a run of the same character at least as long", () => {
		expect(reportFenceLine("```", backticks)).toEqual({ kind: "close" });
		expect(reportFenceLine("   `````  \t", backticks)).toEqual({
			kind: "close",
		});
		expect(reportFenceLine("~~~~~", tildes)).toEqual({ kind: "close" });
	});

	it("keeps every other line inside", () => {
		expect(reportFenceLine("code", backticks)).toEqual({ kind: "inside" });
		expect(reportFenceLine("", backticks)).toEqual({ kind: "inside" });
		expect(reportFenceLine("~~~", backticks)).toEqual({ kind: "inside" });
		expect(reportFenceLine("```", tildes)).toEqual({ kind: "inside" });
		expect(reportFenceLine("~~~", tildes)).toEqual({ kind: "inside" });
		expect(reportFenceLine("``` js", backticks)).toEqual({
			kind: "inside",
		});
		expect(reportFenceLine("    ```", backticks)).toEqual({
			kind: "inside",
		});
	});
});

describe("scanReportCitationsLinear", () => {
	it("reads only well-formed markers", () => {
		expect(
			scanReportCitationsLinear("[S2] [S9] [S2.5] [S02] [S0] [S1000]"),
		).toEqual([2, 9]);
	});

	it("returns unique numbers in numeric order", () => {
		expect(
			scanReportCitationsLinear("[S10] then [S9], [S100] and [S9] again"),
		).toEqual([9, 10, 100]);
	});

	it("skips fenced code", () => {
		const text = lines(
			"Cited [S1].",
			"```",
			"[S4]",
			"```",
			"~~~~",
			"[S5]",
			"~~~",
			"[S6]",
			"~~~~",
			"Cited [S3].",
			"```",
			"[S7] in a fence never closed",
		);
		expect(scanReportCitationsLinear(text)).toEqual([1, 3]);
	});

	it("does not take an inline backtick run for a fence", () => {
		expect(
			scanReportCitationsLinear("```inline``` code [S2]\n[S3]"),
		).toEqual([2, 3]);
	});

	it("skips links and reference definitions", () => {
		expect(scanReportCitationsLinear("[S2](https://example.com)")).toEqual(
			[],
		);
		expect(scanReportCitationsLinear("[S2]: javascript:x")).toEqual([]);
		expect(scanReportCitationsLinear("[S2] (spaced) [S3]:x")).toEqual([2]);
	});

	it("keeps markers in inline code, which the plain-text view shows", () => {
		expect(scanReportCitationsLinear("`[S7]`")).toEqual([7]);
	});

	it("stops after the marker limit, repeats included", () => {
		expect(scanReportCitationsLinear("[S5] [S1] [S3] [S2]", 3)).toEqual([
			1, 3, 5,
		]);
		expect(scanReportCitationsLinear("[S1] [S1] [S2]", 2)).toEqual([1]);
		expect(scanReportCitationsLinear("[S1]", 0)).toEqual([]);

		const many = Array.from({ length: 300 }, (_, i) => `[S${i + 1}]`).join(
			" ",
		);
		const found = scanReportCitationsLinear(many);
		expect(found).toHaveLength(REPORT_CITATION_SCAN_MAX_MARKERS);
		expect(found.at(-1)).toBe(200);
	});

	it("scans a full-size report quickly", () => {
		// Near-misses only, so the scan reads every line to the end.
		const text = `${"[S1000] [S0] [S02] [S1](x) [S".repeat(2_000)}\n[S1]`;
		expect(text.length).toBeLessThanOrEqual(REPORT_TEXT_MAX_CODE_UNITS);
		const { value, ms } = timed(() => scanReportCitationsLinear(text));
		expect(value).toEqual([1]);
		expect(ms).toBeLessThan(200);
	});
});
