import { beforeAll, describe, expect, it } from "vitest";
import { scanReportCitations } from "../lib/proposal-artifact/report-citations";
import {
	REPORT_CITATION_SCAN_MAX_MARKERS,
	REPORT_MAX_LAZY_LINES,
	REPORT_MAX_PARAGRAPH_ANGLE_BRACKETS,
	REPORT_MAX_PARAGRAPH_DELIMITERS,
	REPORT_MAX_PUNCTUATION_RUN,
	REPORT_MAX_TABLE_ROWS,
	REPORT_MAX_TOTAL_BLOCK_LINES,
	REPORT_MAX_TOTAL_LINES,
	REPORT_MAX_TOTAL_TABLE_ROWS,
	REPORT_TEXT_MAX_CODE_UNITS,
	reportTextNeedsPlainText,
} from "../lib/proposal-artifact/report-text";

const lines = (...parts: string[]) => parts.join("\n");

describe("scanReportCitations", () => {
	it("finds markers in prose, headings, table cells and quotes", () => {
		const report = lines(
			"## Pricing [S3]",
			"",
			"The budget matches the brief [S2].",
			"",
			"| Risk | Source |",
			"|------|--------|",
			"| Data migration slips | [S5] |",
			"",
			"> The brief asks for a pilot first [S6].",
		);
		expect(reportTextNeedsPlainText(report)).toBe(false);

		expect(scanReportCitations(report)).toEqual([2, 3, 5, 6]);
	});

	it("skips code, links, reference definitions and footnotes", () => {
		const report = lines(
			"Inline code `[S7]` stays code.",
			"",
			"```",
			"[S8]",
			"```",
			"",
			"A link [S9](https://example.com) is not a citation.",
			"",
			"A reference [S1] resolves to its definition.",
			"",
			"[S1]: javascript:x",
			"",
			"A footnote[^S2] is not one either.",
			"",
			"[^S2]: The footnote text.",
		);
		expect(reportTextNeedsPlainText(report)).toBe(false);

		expect(scanReportCitations(report)).toEqual([]);
	});

	it("skips markers inside a link's text, as the report view does", () => {
		expect(
			scanReportCitations("[See [S1]](https://example.com) and [S2]."),
		).toEqual([2]);
	});

	it("skips a reference link's text, but not text that only looks like one", () => {
		const defined = lines(
			"Cited [S3][ref] here.",
			"",
			"[ref]: https://example.com",
		);
		expect(scanReportCitations(defined)).toEqual([]);
		// Without a definition the brackets stay text, and the view shows a chip.
		expect(scanReportCitations("Cited [S3][ref] here.")).toEqual([3]);
	});

	it("collapses repeats and sorts numerically", () => {
		const report = lines(
			"First [S10], then [S2] and [S10] again.",
			"",
			"- A list item [S2] [S100]",
			"- Another *emphasised [S3]* item",
		);
		expect(scanReportCitations(report)).toEqual([2, 3, 10, 100]);
	});

	it("reads only well-formed markers", () => {
		expect(
			scanReportCitations("[S2] [S9] [S2.5] [S02] [S0] [S1000]"),
		).toEqual([2, 9]);
	});

	it("stops after the marker limit, in document order", () => {
		const report = lines(
			"[S5] intro",
			"",
			"## [S1] heading",
			"",
			"[S3] [S2]",
		);
		expect(scanReportCitations(report, 3)).toEqual([1, 3, 5]);
		expect(scanReportCitations("[S1] [S1] [S2]", 2)).toEqual([1]);
		expect(scanReportCitations("[S1]", 0)).toEqual([]);

		const many = Array.from({ length: 300 }, (_, i) => `[S${i + 1}]`).join(
			" ",
		);
		const found = scanReportCitations(many);
		expect(found).toHaveLength(REPORT_CITATION_SCAN_MAX_MARKERS);
		expect(found.at(-1)).toBe(200);
	});
});

/** `unit(i)` for i = 0, 1, ... as lines, as many as fit in `max` code units. */
function fillLines(unit: (i: number) => string, max = 59_000): string {
	const out: string[] = [];
	let size = 0;
	for (let i = 0; ; i++) {
		const line = unit(i);
		if (size + line.length + 1 > max) {
			return out.join("\n");
		}
		out.push(line);
		size += line.length + 1;
	}
}

/** `text` cut into lines of 3,000 code units, all one paragraph. */
function wrap(text: string): string {
	const out: string[] = [];
	for (let i = 0; i < text.length; i += 3_000) {
		out.push(text.slice(i, i + 3_000));
	}
	return out.join("\n");
}

/** Plain prose of exactly `size` code units. */
const prose = (size: number) =>
	"The example rollout keeps its pilot scope. "
		.repeat(Math.ceil(size / 43))
		.slice(0, size);

/** A table of `rows` rows (header included); `cell` writes each body cell. */
function table(
	header: readonly string[],
	rows: number,
	cell: (row: number, column: number) => string,
): string {
	const row = (cells: readonly string[]) => `| ${cells.join(" | ")} |`;
	return lines(
		row(header),
		`|${"---|".repeat(header.length)}`,
		...Array.from({ length: rows - 1 }, (_, r) =>
			row(header.map((_, c) => cell(r, c))),
		),
	);
}

const PRIORITIES = ["Must", "Should", "Could"];

const tightList = Array.from(
	{ length: 60 },
	(_, i) => `- **Lead ${i}**: some text with a [S2] marker`,
).join("\n");

const scopeTable = table(
	["Item", "Priority", "In proposal", "Note"],
	41,
	(r, c) => [`Item ${r}`, `**${PRIORITIES[r % 3]}**`, "Partially", "note"][c],
);

/** A typical full report: headings, two tables, lists, a quote and code. */
function fullReport(): string {
	const findings = Array.from({ length: 20 }, (_, i) =>
		lines(
			`### Finding ${i + 1}: timeline assumption`,
			"",
			`The proposal assumes the pilot starts in week ${i + 2}, while the brief asks for a discovery phase first [S${(i % 6) + 1}]. The _staffing_ plan names two engineers for the integration work, which matches the **minimum** in the brief [S${(i % 4) + 2}].`,
			"",
			`- **Impact**: the schedule slips by about ${i + 1} weeks if discovery runs long.`,
			`- **Evidence**: the brief's milestone table [S${(i % 3) + 1}] and the proposal's plan.`,
			`  - **Detail**: the plan lists ${i + 3} milestones, see [the brief](https://example.com/brief).`,
			"- **Recommendation**: add a discovery gate before the pilot.",
		),
	);
	const risks = table(
		["Risk", "Likelihood", "Mitigation"],
		25,
		(r, c) =>
			[
				`Risk ${r}: the data migration slips`,
				"Medium",
				`Stage the cut-over by region [S${(r % 5) + 1}]`,
			][c],
	);
	return lines(
		"# Internal analysis: example rollout proposal",
		"",
		"**Overall assessment:** Ready with changes.",
		"",
		"## Summary",
		"",
		`${prose(900)} [S1]`,
		"",
		`${prose(700)} [S2]`,
		"",
		"## Scope coverage",
		"",
		scopeTable,
		"",
		"## Findings",
		"",
		findings.join("\n\n"),
		"",
		"## Risks",
		"",
		risks,
		"",
		"## Before sending",
		"",
		...Array.from(
			{ length: 15 },
			(_, i) =>
				`${i + 1}. **Confirm** item ${i} with the client _before_ sending [S${(i % 7) + 1}].`,
		),
		"",
		"## During discovery",
		"",
		...Array.from(
			{ length: 12 },
			(_, i) =>
				`- Check the ${i}th assumption about the example data (< 5% gaps).`,
		),
		"",
		"> The brief asks for a pilot in one region first [S3].",
		"",
		"```json",
		'{ "example": true }',
		"```",
	);
}

/**
 * The fastest of three parses, in milliseconds: the parser's own cost, not
 * a garbage-collection pause or another process on the machine.
 */
function parseMs(text: string): number {
	let fastest = Number.POSITIVE_INFINITY;
	for (let run = 0; run < 3; run++) {
		const started = performance.now();
		scanReportCitations(text);
		fastest = Math.min(fastest, performance.now() - started);
	}
	return fastest;
}

describe("parse time of reports the check passes", () => {
	beforeAll(() => {
		scanReportCitations("# Warm-up\n\n- an item with **bold** [S1]");
	});

	it("passes realistic reports", () => {
		const report = fullReport();
		expect(report.length).toBeGreaterThan(18_000);
		expect(report.length).toBeLessThan(25_000);
		for (const text of [tightList, scopeTable, report]) {
			expect(reportTextNeedsPlainText(text)).toBe(false);
		}
		expect(scanReportCitations(report)).toEqual([1, 2, 3, 4, 5, 6, 7]);
	});

	const blockLines = REPORT_MAX_TOTAL_BLOCK_LINES;
	const angles = REPORT_MAX_PARAGRAPH_ANGLE_BRACKETS;
	const delimiters = REPORT_MAX_PARAGRAPH_DELIMITERS;
	const tableRows = REPORT_MAX_TABLE_ROWS;
	const containerLine = "- - - - - - - - **a** [S1]";
	const blocks = Array.from({ length: blockLines }, () => containerLine);
	/** One paragraph: `opener` as often as allowed, then prose to `size`. */
	const openersThenProse = (opener: string, size = 59_000) =>
		wrap(opener.repeat(angles) + prose(size - opener.length * angles));
	/** Short words, the most walks per code unit. */
	const words = (count: number) =>
		"a ".repeat(Math.ceil(count / 2)).slice(0, count);
	const lazyLines = REPORT_MAX_LAZY_LINES;
	/**
	 * Paragraphs that each open with `opener`, then hold `lazy` lazy lines of
	 * prose, as many as the line limit allows, `separator` between them.
	 */
	const lazyParagraphs = (
		opener: string,
		separator: string,
		lazy = lazyLines,
	) => {
		const paragraph = lines(
			opener,
			...Array.from({ length: lazy }, () => prose(20)),
		);
		const count = Math.floor(
			REPORT_MAX_TOTAL_LINES / (opener.split("\n").length + lazy),
		);
		return Array.from({ length: count }, () => paragraph).join(separator);
	};
	/** 15 lines, each a bare URL whose path holds `run` again and again. */
	const bareUrlRuns = (run: string) =>
		Array.from(
			{ length: 15 },
			() =>
				`See www.example.com/${`${run}x`.repeat(Math.floor(3_800 / (run.length + 1)))} [S1]`,
		).join("\n");
	/** 15 lines, each a bare `www.` domain made of `run` again and again. */
	const bareDomainRuns = (run: string) =>
		Array.from(
			{ length: 15 },
			() =>
				`See www.${`${run}x`.repeat(Math.floor(3_800 / (run.length + 1)))} [S1]`,
		).join("\n");
	/** 15 lines, each holding `run` outside any URL. */
	const plainRuns = (run: string) =>
		Array.from({ length: 15 }, () => `See ${run} [S1]`).join("\n");
	/** One paragraph of as many `unit` as the check passes, in lines of 3,000. */
	const mostJoins = (unit: string) => {
		let low = 0;
		let high = Math.floor(59_000 / unit.length);
		while (low < high) {
			const middle = Math.ceil((low + high) / 2);
			if (reportTextNeedsPlainText(wrap(unit.repeat(middle)))) {
				high = middle - 1;
			} else {
				low = middle;
			}
		}
		return wrap(unit.repeat(low));
	};
	/** `count` non-blank lines of prose, ten to a paragraph. */
	const tenLineParagraphs = (count: number) =>
		Array.from({ length: count / 10 }, () =>
			lines(...Array.from({ length: 10 }, () => prose(16))),
		).join("\n\n");

	it.each([
		["a tight list of 60 bold leads", tightList],
		["a 41-row scope table with bold cells", scopeTable],
		["a typical full report", fullReport()],
		[
			"a 99-row table of `<br>` cells",
			table(["Item", "Note"], 99, (r, c) =>
				c === 0 ? `Item ${r}` : "first<br>second<br/>third",
			),
		],
		[
			"the most table rows, at the most cells",
			Array.from({ length: 3 }, (_, t) =>
				table(
					Array.from({ length: 12 }, (_, c) => `h${c}`),
					t < 2
						? tableRows
						: REPORT_MAX_TOTAL_TABLE_ROWS - 2 * tableRows,
					(r, c) => `r${r}c${c}`,
				),
			).join("\n\n"),
		],
		["the most block lines, each opening 8 containers", blocks.join("\n")],
		["the most unclosed `<?` in one paragraph", openersThenProse("x <?a ")],
		[
			"the most unclosed `<!--` in one paragraph",
			openersThenProse("x <!--a "),
		],
		[
			"the most unclosed `<?` in every list item",
			fillLines(() => `- ${"x <?a ".repeat(angles)}${prose(400)}`),
		],
		[
			"the most delimiters in every list item",
			fillLines(() => `- ${"*a".repeat(delimiters)}`),
		],
		[
			"the most delimiters in every ordered item",
			fillLines((i) => `${i + 1}. ${"*a".repeat(delimiters)}`),
		],
		["an unclosed `[` with the most words after it", `[ ${words(2_700)}`],
		[
			"the most unmatched `]` after a long paragraph",
			wrap(`${words(50_000)}${"]".repeat(75)}`),
		],
		[
			"the most of each in every list item",
			fillLines(
				() =>
					`- ${"*a".repeat(delimiters)} ${"[a] ".repeat(80)}${" x <?a".repeat(angles)}`,
			),
		],
		[
			"the most block lines, then the most `<?` in one paragraph",
			lines(
				...blocks,
				"",
				openersThenProse(
					"x <?a ",
					59_000 - blocks.join("\n").length - 2,
				),
			),
		],
		[
			"the most lazy lines under quotes",
			lazyParagraphs("> **Note** [S1]", "\n\n"),
		],
		[
			"the most lazy lines under nested quotes",
			lazyParagraphs(">>>>>>>> **Note** [S1]", "\n\n"),
		],
		[
			"the most lazy lines under list items",
			lazyParagraphs("- **Note** [S1]", "\n"),
		],
		[
			"the most lazy lines under ordered items",
			lazyParagraphs("1. **Note** [S1]", "\n"),
		],
		[
			"the most lazy lines in list items continued past a blank line",
			// The indented line is the first of the lazy lines.
			lazyParagraphs(
				"- **Note** [S1]\n\n  continued",
				"\n",
				lazyLines - 1,
			),
		],
		[
			"the longest runs of `.` in a bare URL on every line",
			bareUrlRuns(".".repeat(REPORT_MAX_PUNCTUATION_RUN)),
		],
		[
			"the longest runs of `?` in a bare URL on every line",
			bareUrlRuns("?".repeat(REPORT_MAX_PUNCTUATION_RUN)),
		],
		[
			"the longest runs of `.` in a bare URL's domain on every line",
			bareDomainRuns(".".repeat(REPORT_MAX_PUNCTUATION_RUN)),
		],
		[
			"a run of 3,970 `.` outside any URL on every line",
			plainRuns(".".repeat(3_970)),
		],
		[
			"a run of 3,970 `-` outside any URL on every line",
			plainRuns("-".repeat(3_970)),
		],
		[
			"a run of 3,970 `?` outside any URL on every line",
			plainRuns("?".repeat(3_970)),
		],
		["the most lines, ten to a paragraph", tenLineParagraphs(3_000)],
		["the most lines, each a paragraph", "a\n\n".repeat(3_000)],
		["the most `<a` lines in one paragraph", "<a\n".repeat(3_000)],
		["the most escapes in one paragraph", mostJoins("<a\\.")],
		[
			"the most character references in one paragraph",
			mostJoins("a b&amp;"),
		],
		["the most tags in one paragraph", mostJoins("a b<b>")],
		["the most code spans in one paragraph", mostJoins("a b`c`")],
		[
			"the most bare URLs in one paragraph",
			mostJoins("a b www.example.com "),
		],
		[
			"the most bare email addresses in one paragraph",
			mostJoins("a b c@example.com "),
		],
	])(
		"parses %s within a second",
		(_label, text) => {
			expect(text.length).toBeLessThanOrEqual(REPORT_TEXT_MAX_CODE_UNITS);
			expect(reportTextNeedsPlainText(text)).toBe(false);
			expect(parseMs(text)).toBeLessThan(1_000);
		},
		20_000,
	);
});
