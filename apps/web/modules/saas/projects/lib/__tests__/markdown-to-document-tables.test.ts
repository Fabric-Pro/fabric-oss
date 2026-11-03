/**
 * A GFM table renders as a table in the regular PDF and DOCX downloads, not
 * as lines of raw pipes, and stays on the page of the heading above it; a
 * horizontal rule in any spelling is a break, never a list item. The PDF
 * checks read jsPDF's real, uncompressed output; the DOCX checks record what
 * is handed to docx.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { layOutPdfTable, readMarkdownTable } from "../document-export-helpers";
import {
	renderMarkdownToDocx,
	renderMarkdownToPdf,
} from "../markdown-to-document";

const recorder = vi.hoisted(() => ({
	texts: [] as string[],
	tables: [] as { rows: number }[],
	headerRows: 0,
	bullets: 0,
}));

vi.mock("docx", async (importOriginal) => {
	const actual = await importOriginal<typeof import("docx")>();
	class TextRun extends actual.TextRun {
		constructor(options: ConstructorParameters<typeof actual.TextRun>[0]) {
			super(options);
			recorder.texts.push(
				typeof options === "string"
					? options
					: String(options.text ?? ""),
			);
		}
	}
	class Paragraph extends actual.Paragraph {
		constructor(
			options: ConstructorParameters<typeof actual.Paragraph>[0],
		) {
			super(options);
			if (typeof options === "string") {
				recorder.texts.push(options);
			} else if (options?.text) {
				recorder.texts.push(options.text);
			}
			if (typeof options !== "string" && options?.bullet) {
				recorder.bullets += 1;
			}
		}
	}
	class Table extends actual.Table {
		constructor(options: ConstructorParameters<typeof actual.Table>[0]) {
			super(options);
			recorder.tables.push({ rows: options.rows.length });
		}
	}
	class TableRow extends actual.TableRow {
		constructor(options: ConstructorParameters<typeof actual.TableRow>[0]) {
			super(options);
			if (options.tableHeader) {
				recorder.headerRows += 1;
			}
		}
	}
	return { ...actual, Paragraph, TextRun, Table, TableRow };
});

const markdown = [
	"## Delivery Approach",
	"",
	"| Stage | Outcome |",
	"| --- | :--- |",
	"| Discovery | Confirmed scope and **catalog** access |",
	"| Pilot | Five dealers \\| live projects |",
	"",
	"Next steps follow.",
].join("\n");

function readBlobText(blob: Blob): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onloadend = () => resolve(reader.result as string);
		reader.onerror = reject;
		reader.readAsText(blob);
	});
}

/** The content stream of each page, in order, from jsPDF's uncompressed output. */
function pageStreams(pdf: string): string[] {
	return [...pdf.matchAll(/stream\r?\n([\s\S]*?)endstream/g)]
		.map((match) => match[1])
		.filter((stream) => /\bBT\b/.test(stream));
}

beforeEach(() => {
	recorder.texts.length = 0;
	recorder.tables.length = 0;
	recorder.headerRows = 0;
	recorder.bullets = 0;
});

describe("readMarkdownTable", () => {
	const lines = markdown.split("\n");

	it("reads the header, skips the delimiter and stops at the first non-row", () => {
		expect(readMarkdownTable(lines, 2)).toEqual({
			rows: [
				["Stage", "Outcome"],
				["Discovery", "Confirmed scope and **catalog** access"],
				["Pilot", "Five dealers \\| live projects"],
			],
			columns: 2,
			next: 6,
		});
	});

	it("is null where no table starts", () => {
		expect(readMarkdownTable(lines, 0)).toBeNull();
		expect(readMarkdownTable(lines, 3)).toBeNull();
		expect(
			readMarkdownTable(["| Stage | Outcome |", "Plain text"], 0),
		).toBeNull();
	});

	it("counts the widest row's columns when rows are ragged", () => {
		expect(
			readMarkdownTable(["| A | B |", "| - | - |", "| 1 | 2 | 3 |"], 0)
				?.columns,
		).toBe(3);
	});
});

describe("layOutPdfTable", () => {
	/** Half an em per character at 9.5pt. */
	const measure = (text: string) => text.length * 4.75;
	const layOut = (rows: string[][], width: number) =>
		layOutPdfTable(rows, {
			columns: rows[0].length,
			width,
			padding: 5,
			fontSize: 9.5,
			minFontSize: 8,
			measure,
		});
	const widths = (layout: ReturnType<typeof layOut>) =>
		layout.columns.map((column) => column.width);
	const total = (values: number[]) => values.reduce((a, b) => a + b, 0);

	it("gives the slack to the column whose text runs longer, keeping each word on one line", () => {
		const layout = layOut(
			[["aaaa aaaa aaaa aaaa aaaa aaaa", "bbbbbbbbbbbb"]],
			200,
		);

		expect(layout.fontSize).toBe(9.5);
		expect(widths(layout)[1] - 10).toBeGreaterThanOrEqual(
			measure("b".repeat(12)),
		);
		expect(widths(layout)[0]).toBeGreaterThan(widths(layout)[1]);
		expect(total(widths(layout))).toBeCloseTo(200, 6);
		expect(layout.columns[1].left).toBeCloseTo(widths(layout)[0], 6);
	});

	it("steps the font down by quarter points when the widest words do not fit side by side", () => {
		const layout = layOut([["a".repeat(10), "b".repeat(10)]], 110);

		expect(layout.fontSize).toBe(8.75);
		for (const width of widths(layout)) {
			expect(width - 10).toBeGreaterThanOrEqual((10 * 8.75) / 2);
		}
		expect(total(widths(layout))).toBeCloseTo(110, 6);
	});

	it("stops at the smallest font size and still fills the table", () => {
		const layout = layOut([["a".repeat(10), "b".repeat(10)]], 100);

		expect(layout.fontSize).toBe(8);
		expect(total(widths(layout))).toBeCloseTo(100, 6);
	});

	it("lets a link wider than any word break in its cell instead of shrinking the table", () => {
		const layout = layOut([["x".repeat(40), "word"]], 150);

		expect(layout.fontSize).toBe(9.5);
		expect(widths(layout)[1] - 10).toBeGreaterThanOrEqual(measure("word"));
	});

	it("keeps a long identifier whole when an even share of the table holds it", () => {
		const identifier = "resolveExampleWorkspaceMembership";
		const sentence = Array(30).fill("word").join(" ");
		const layout = layOut([[identifier, sentence]], 499.28);

		expect(layout.fontSize).toBe(9.5);
		expect(widths(layout)[0] - 10).toBeGreaterThanOrEqual(
			measure(identifier),
		);
	});

	it("treats a word exactly at the cap as a word that must stay whole", () => {
		// 22 characters measure 104.5pt, eleven ems at 9.5pt.
		const words = ["a", "b", "c"].map((c) => c.repeat(22));
		const layout = layOut([words], 300);

		for (const width of widths(layout)) {
			expect(width - 10).toBeGreaterThanOrEqual(
				(measure(words[0]) * layout.fontSize) / 9.5,
			);
		}
	});

	it("lets a link settle for a few characters a line when an even share would crowd the other columns' words", () => {
		const layout = layOut(
			[["x".repeat(40), "a".repeat(20), "b".repeat(20)]],
			300,
		);

		expect(layout.fontSize).toBe(9.5);
		expect(widths(layout)[1] - 10).toBeGreaterThanOrEqual(
			measure("a".repeat(20)),
		);
		expect(widths(layout)[2] - 10).toBeGreaterThanOrEqual(
			measure("b".repeat(20)),
		);
	});

	it("leaves every column room for text when the padding alone would fill the table", () => {
		const columns = 60;
		const layout = layOut([Array(columns).fill("x")], 499.28);

		for (const { width } of layout.columns) {
			expect(width - layout.padding * 2).toBeGreaterThanOrEqual(
				measure("x") * (layout.fontSize / 9.5),
			);
		}
		expect(total(widths(layout))).toBeCloseTo(499.28, 6);
	});

	it("keeps the font and every word when several columns hold links", () => {
		const link = (c: string) => c.repeat(40);
		const layout = layOut(
			[[link("x"), link("y"), link("z"), "word", "word"]],
			300,
		);

		expect(layout.fontSize).toBe(9.5);
		expect(widths(layout)[3] - 10).toBeGreaterThanOrEqual(measure("word"));
		expect(widths(layout)[4] - 10).toBeGreaterThanOrEqual(measure("word"));
		expect(total(widths(layout))).toBeCloseTo(300, 6);
	});
});

describe("regular downloads render tables", () => {
	it("draws the PDF table's cells, with no raw pipe rows", async () => {
		const pdf = await readBlobText(await renderMarkdownToPdf(markdown));

		expect(pdf).toContain("Stage");
		expect(pdf).toContain("Discovery");
		expect(pdf).toContain("Confirmed scope and catalog access");
		expect(pdf).toContain("Five dealers | live projects");
		expect(pdf).toContain("Next steps follow.");
		expect(pdf).not.toContain("| Stage |");
		expect(pdf).not.toContain("| --- |");
	});

	it("builds a DOCX table with a repeated header row", async () => {
		await renderMarkdownToDocx(markdown, "Delivery");

		expect(recorder.tables).toEqual([{ rows: 3 }]);
		expect(recorder.headerRows).toBe(1);
		expect(recorder.texts).toEqual(
			expect.arrayContaining([
				"Stage",
				"Outcome",
				"Discovery",
				"catalog",
				"Five dealers | live projects",
				"Next steps follow.",
			]),
		);
		// No raw row survives: a cell's own escaped pipe is content.
		expect(
			recorder.texts.filter((text) => text.trim().startsWith("|")),
		).toEqual([]);
	});

	it("draws only characters the PDF fonts have, in prose and in cells", async () => {
		const pdf = await readBlobText(
			await renderMarkdownToPdf(
				[
					"Uptime target ≥ 99.5% → reviewed monthly.",
					"",
					"| Goal | Metric |",
					"| --- | --- |",
					"| Reliability | ≥ 99.5% uptime |",
				].join("\n"),
			),
		);

		expect(pdf).toContain("Uptime target >= 99.5% -> reviewed monthly.");
		expect(pdf).toContain(">= 99.5% uptime");
	});

	it("repeats the header row on every page a long table continues onto", async () => {
		const rows = Array.from(
			{ length: 80 },
			(_, n) => `| Stage ${n + 1} | Outcome ${n + 1} |`,
		);
		const pdf = await readBlobText(
			await renderMarkdownToPdf(
				["| Stage | Outcome |", "| --- | --- |", ...rows].join("\n"),
			),
		);
		const pages = pageStreams(pdf);

		expect(pages.length).toBeGreaterThan(1);
		for (const page of pages) {
			expect(page).toContain("(Stage)");
		}
	});

	it("never leaves the header row alone at the foot of a page", async () => {
		// Enough prose to bring the table's start to the bottom of page one.
		const filler = Array.from(
			{ length: 46 },
			(_, n) => `Paragraph ${n + 1}.`,
		);
		const pdf = await readBlobText(
			await renderMarkdownToPdf(
				[
					...filler,
					"",
					"| Stage | Outcome |",
					"| --- | --- |",
					"| Discovery | Confirmed scope |",
				].join("\n"),
			),
		);
		const headerPage = pageStreams(pdf).find((page) =>
			page.includes("(Stage)"),
		);

		expect(headerPage).toBeDefined();
		expect(headerPage).toContain("(Discovery)");
	});

	it("leaves a pipe line that starts no table as text", async () => {
		await renderMarkdownToDocx("| not a table |\nPlain text", "Note");

		expect(recorder.tables).toEqual([]);
		expect(recorder.texts).toContain("| not a table |");
	});

	it("keeps a heading on the page where its table starts", async () => {
		// Leaves room for the heading at the foot of page one, not for the
		// table under it.
		const filler = Array.from(
			{ length: 46 },
			(_, n) => `Paragraph ${n + 1}.`,
		);
		const pdf = await readBlobText(
			await renderMarkdownToPdf(
				[
					...filler,
					"",
					"## Success Metrics",
					"",
					"| Stage | Outcome |",
					"| --- | --- |",
					"| Discovery | Confirmed scope |",
				].join("\n"),
			),
		);
		const headingPage = pageStreams(pdf).find((page) =>
			page.includes("(Success Metrics)"),
		);

		expect(headingPage).toBeDefined();
		expect(headingPage).toContain("(Stage)");
	});

	it("sizes the columns to their words, so no cell splits a word across lines", async () => {
		const pdf = await readBlobText(
			await renderMarkdownToPdf(successMetrics().join("\n")),
		);
		const tokens = drawnStrings(pdf).flatMap((text) => text.split(" "));

		expect(tokens).toEqual(
			expect.arrayContaining([
				"Measurement",
				"implementation",
				"Implementation",
				"Responsibilities",
				"accommodation",
			]),
		);
		for (const token of tokens) {
			expect(cellWords(successMetrics())).toContain(token);
		}
	});

	it("keeps the words of every other column whole when a cell holds a long link", async () => {
		const rows = successMetrics(
			"https://example.com/reports/2026/quarterly-baseline-measurement-summary",
		);
		const pdf = await readBlobText(
			await renderMarkdownToPdf(rows.join("\n")),
		);
		const words = cellWords(rows).filter(
			(word) => !word.startsWith("http"),
		);
		const tokens = drawnStrings(pdf).flatMap((text) => text.split(" "));

		for (const word of words) {
			expect(tokens).toContain(word);
		}
	});

	it("draws a row taller than a page across pages, inside the margins, repeating the header", async () => {
		const pdf = await readBlobText(
			await renderMarkdownToPdf(
				[
					"## Delivery log",
					"",
					"| Stage | Notes |",
					"| --- | --- |",
					`| Discovery | ${Array(3000).fill("word").join(" ")} |`,
				].join("\n"),
			),
		);
		const pages = pageStreams(pdf);
		const tokens = drawnStrings(pdf).flatMap((text) => text.split(" "));

		expect(pages.length).toBeGreaterThan(1);
		expect(tokens.filter((token) => token === "word")).toHaveLength(3000);
		// The table starts under its heading rather than leaving it alone.
		expect(pages[0]).toContain("(Delivery log)");
		expect(pages[0]).toContain("(word");
		for (const page of pages) {
			expect(page).toContain("(Stage)");
			for (const baseline of lowestBaselines(page)) {
				expect(baseline).toBeGreaterThanOrEqual(48);
			}
		}
	});

	it("moves a row that fits on a page to the next page whole, wherever the page ends", async () => {
		const tail = Array(70).fill("tail").join(" ");
		for (let n = 20; n <= 45; n++) {
			const short = Array.from(
				{ length: n },
				(_, i) => `| r${i} | short |`,
			);
			const pdf = await readBlobText(
				await renderMarkdownToPdf(
					[
						"| Stage | Notes |",
						"| --- | --- |",
						...short,
						`| Last | ${tail} |`,
					].join("\n"),
				),
			);
			const holding = pageStreams(pdf).filter((page) =>
				page.includes("(tail"),
			);

			expect(holding).toHaveLength(1);
			expect(holding[0]).toContain("(Stage)");
		}
	});

	it("keeps ordinary words whole when several columns hold links", async () => {
		const link = (name: string) =>
			`https://example.com/reports/2026/${name}-quarterly-baseline-measurement`;
		const rows = [
			"| Goal | Metric | Source | Dashboard | Owner | Archive | Status |",
			"| --- | --- | --- | --- | --- | --- | --- |",
			`| Reduce implementation time | Implementation lead time | ${link("source")} | ${link("dashboard")} | Delivery Responsibilities Lead | ${link("archive")} | Not started |`,
		];
		const pdf = await readBlobText(
			await renderMarkdownToPdf(rows.join("\n")),
		);
		const words = cellWords(rows).filter(
			(word) => !word.startsWith("http"),
		);
		const tokens = drawnStrings(pdf).flatMap((text) => text.split(" "));

		for (const word of words) {
			expect(tokens).toContain(word);
		}
	});

	it("keeps a long identifier whole in a two-column table", async () => {
		const identifier = "resolveExampleWorkspaceMembership";
		const pdf = await readBlobText(
			await renderMarkdownToPdf(
				[
					"| Function | Description |",
					"| --- | --- |",
					`| ${identifier} | Returns the membership row the example workspace grants to the signed-in member, or nothing when the member has left. |`,
				].join("\n"),
			),
		);

		expect(drawnStrings(pdf)).toContain(identifier);
	});

	it("draws each cell of a sixty-column table once, on one line", async () => {
		const row = `|${" x |".repeat(60)}`;
		const pdf = await readBlobText(
			await renderMarkdownToPdf(
				[row, `|${" --- |".repeat(60)}`, row].join("\n"),
			),
		);

		expect(drawnStrings(pdf)).toEqual(Array(120).fill("x"));
	});

	it("steps the table font down to keep words whole when they cannot fit side by side at full size", async () => {
		const pdf = await readBlobText(
			await renderMarkdownToPdf(crowdedTable().join("\n")),
		);
		const tokens = drawnStrings(pdf).flatMap((text) => text.split(" "));

		expect(tokens).toEqual(
			expect.arrayContaining(cellWords(crowdedTable())),
		);
		for (const token of tokens) {
			expect(cellWords(crowdedTable())).toContain(token);
		}
	});
});

/**
 * Seven one-word columns whose words together run wider than the page at
 * 9.5pt but fit once the table font steps down.
 */
function crowdedTable(): string[] {
	return [
		"| A | B | C | D | E | F | G |",
		"| --- | --- | --- | --- | --- | --- | --- |",
		"| Internationalization | Accommodation | Responsibilities | Accountabilities | Implementation | Interoperability | Questionnaire |",
	];
}

/**
 * The success-metrics table a Business Case carries: seven columns whose
 * cells hold words wider than an even seventh of the page.
 */
function successMetrics(evidence = "Baseline report"): string[] {
	return [
		"| Goal | Metric | Target | Measurement Method | Owner | Status | Evidence |",
		"| --- | --- | --- | --- | --- | --- | --- |",
		`| Reduce implementation time | Implementation lead time | 30% faster | Quarterly measurement | Delivery Responsibilities Lead | Not started | ${evidence} |`,
		"| Improve accommodation | Customer satisfaction | 4.5 of 5 | Survey questionnaire | Customer Experience | In progress | TBD |",
	];
}

/** Every word of a table's cells. */
function cellWords(rows: string[]): string[] {
	return rows
		.filter((row) => !row.includes("---"))
		.flatMap((row) => row.split("|"))
		.flatMap((cell) => cell.trim().split(" "))
		.filter(Boolean);
}

/** Every string the PDF draws, from jsPDF's uncompressed content streams. */
function drawnStrings(pdf: string): string[] {
	return pageStreams(pdf).flatMap((page) =>
		[...page.matchAll(/\(((?:\\.|[^\\)])*)\) Tj/g)].map(
			(match) => match[1],
		),
	);
}

/**
 * The last baseline of each text block on a page, in points above the
 * page's foot: jsPDF starts a block at `x y Td` and steps down one `TL` per
 * further line.
 */
function lowestBaselines(page: string): number[] {
	return [...page.matchAll(/\bBT\b([\s\S]*?)\bET\b/g)].map(([, block]) => {
		const leading = Number(block.match(/([\d.]+) TL/)?.[1] ?? 0);
		const start = Number(block.match(/[\d.]+ ([\d.]+) Td/)?.[1] ?? 0);
		const lines = block.match(/\) Tj/g)?.length ?? 1;
		return start - (lines - 1) * leading;
	});
}

describe("horizontal rules", () => {
	const around = (rule: string) =>
		["Before.", "", rule, "", "After."].join("\n");

	it.each(["* * *", "***", "___", "- - -"])(
		"draws %s in a PDF exactly as ---, not as a bullet",
		async (rule) => {
			const expected = await readBlobText(
				await renderMarkdownToPdf(around("---")),
			);
			const pdf = await readBlobText(
				await renderMarkdownToPdf(around(rule)),
			);

			expect(pageStreams(pdf)).toEqual(pageStreams(expected));
		},
	);

	it("adds no list item to a DOCX for the editor's * * * rule", async () => {
		await renderMarkdownToDocx(around("* * *"), "Rule");

		expect(recorder.bullets).toBe(0);
		expect(recorder.texts.join(" ")).not.toContain("*");
	});

	it("still reads * item as a list item", async () => {
		await renderMarkdownToDocx("* item", "List");

		expect(recorder.bullets).toBe(1);
	});
});
