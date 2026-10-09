/**
 * A GFM table renders as a table in the regular PDF and DOCX downloads, not
 * as lines of raw pipes, and stays on the page of the heading above it; a
 * horizontal rule in any spelling is a break, never a list item. The PDF
 * checks read jsPDF's real, uncompressed output; the DOCX checks record what
 * is handed to docx.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readMarkdownTable } from "../document-export-helpers";
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
});

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
