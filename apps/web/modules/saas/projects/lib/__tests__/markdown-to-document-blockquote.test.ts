/**
 * A `>` blockquote renders as a quote in the regular PDF and DOCX downloads:
 * indented, its paragraphs kept apart and its bold label still bold, never as
 * a paragraph opening with a literal `>`. A `> - item` line stays part of the
 * quote rather than becoming a bullet, and the paragraph after a quote is
 * drawn as before. The PDF checks read jsPDF's real, uncompressed output; the
 * DOCX checks record what is handed to docx.
 */
import { jsPDF } from "jspdf";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	layOutPdfRuns,
	readBoldRuns,
	readMarkdownBlockquote,
	stripInlineMarkdown,
	toWinAnsiText,
} from "../document-export-helpers";
import {
	renderMarkdownToDocx,
	renderMarkdownToPdf,
} from "../markdown-to-document";

const recorder = vi.hoisted(() => ({
	runs: [] as { text: string; bold: boolean }[],
	runText: new WeakMap<object, string>(),
	paragraphs: [] as { text: string; indented: boolean; bordered: boolean }[],
	bullets: 0,
}));

vi.mock("docx", async (importOriginal) => {
	const actual = await importOriginal<typeof import("docx")>();
	class TextRun extends actual.TextRun {
		constructor(options: ConstructorParameters<typeof actual.TextRun>[0]) {
			super(options);
			const run =
				typeof options === "string"
					? { text: options, bold: false }
					: {
							text: String(options.text ?? ""),
							bold: options.bold === true,
						};
			recorder.runs.push(run);
			recorder.runText.set(this, run.text);
		}
	}
	class Paragraph extends actual.Paragraph {
		constructor(
			options: ConstructorParameters<typeof actual.Paragraph>[0],
		) {
			super(options);
			if (typeof options === "string") {
				recorder.paragraphs.push({
					text: options,
					indented: false,
					bordered: false,
				});
				return;
			}
			const children = (options?.children ?? []) as object[];
			recorder.paragraphs.push({
				text:
					options?.text ??
					children
						.map((child) => recorder.runText.get(child) ?? "")
						.join(""),
				indented: Boolean(options?.indent?.left),
				bordered: Boolean(options?.border?.left),
			});
			if (options?.bullet) {
				recorder.bullets += 1;
			}
		}
	}
	return { ...actual, Paragraph, TextRun };
});

/**
 * A string's width at 11pt as the PDF draws it: a Tj string is drawn
 * without kerning, so pairs such as `Te` take their full width.
 */
function drawnWidth(text: string, bold: boolean): number {
	const doc = new jsPDF({ unit: "pt", format: "a4" });
	doc.setFontSize(11);
	doc.setFont("helvetica", bold ? "bold" : "normal");
	return (
		(doc.getStringUnitWidth(text, { kerning: {} }) * doc.getFontSize()) /
		doc.internal.scaleFactor
	);
}

const notice = [
	"## Market context",
	"",
	"> **Research incomplete.** Two of the five searches returned nothing,",
	"> so the figures below lean on the project's own context.",
	">",
	"> **Sources.** Review them before sending.",
	"",
	"The analysis follows.",
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

/** Each string the PDF draws, with the x and the font of the text block it starts. */
function drawnBlocks(
	pdf: string,
): { x: number; font: string; strings: string[] }[] {
	return pageStreams(pdf).flatMap((page) =>
		[...page.matchAll(/\bBT\b([\s\S]*?)\bET\b/g)].map(([, block]) => ({
			x: Number(block.match(/([\d.]+) [\d.]+ Td/)?.[1] ?? Number.NaN),
			font: block.match(/\/(F\d+) [\d.]+ Tf/)?.[1] ?? "",
			strings: [...block.matchAll(/\(((?:\\.|[^\\)])*)\) Tj/g)].map(
				(match) => match[1],
			),
		})),
	);
}

/** The block that draws a string; fails when the string is not drawn. */
function blockOf(
	blocks: ReturnType<typeof drawnBlocks>,
	text: string,
): ReturnType<typeof drawnBlocks>[number] {
	const block = blocks.find((candidate) =>
		candidate.strings.some((drawn) => drawn.includes(text)),
	);
	if (!block) {
		throw new Error(`not drawn: ${text}`);
	}
	return block;
}

/** The x a drawn string starts at; fails when the string is not drawn. */
function xOf(blocks: ReturnType<typeof drawnBlocks>, text: string): number {
	return blockOf(blocks, text).x;
}

/** The quote bars, thin filled rectangles, each page draws, in page order. */
function barsPerPage(pdf: string): number[] {
	return pageStreams(pdf).map(
		(page) =>
			[...page.matchAll(/[\d.]+ [\d.]+ 2\.0* -[\d.]+ re\s+f\b/g)].length,
	);
}

/** How many drawn strings on each page contain `text`, in page order. */
function linesPerPage(pdf: string, text: string): number[] {
	return pageStreams(pdf).map(
		(page) =>
			[...page.matchAll(/\(((?:\\.|[^\\)])*)\) Tj/g)].filter((match) =>
				match[1].includes(text),
			).length,
	);
}

beforeEach(() => {
	recorder.runs.length = 0;
	recorder.paragraphs.length = 0;
	recorder.bullets = 0;
});

describe("readMarkdownBlockquote", () => {
	const lines = notice.split("\n");

	it("joins a paragraph's lines, splits on a bare > and stops at the first non-quote line", () => {
		expect(readMarkdownBlockquote(lines, 2)).toEqual({
			paragraphs: [
				"**Research incomplete.** Two of the five searches returned nothing, so the figures below lean on the project's own context.",
				"**Sources.** Review them before sending.",
			],
			next: 6,
		});
	});

	it("is null where no quote starts", () => {
		expect(readMarkdownBlockquote(lines, 0)).toBeNull();
		expect(readMarkdownBlockquote(lines, 7)).toBeNull();
		expect(readMarkdownBlockquote(lines, 99)).toBeNull();
	});

	it("reads an indented marker and one without a following space", () => {
		expect(readMarkdownBlockquote(["  >First", ">", ">Second"], 0)).toEqual(
			{ paragraphs: ["First", "Second"], next: 3 },
		);
	});
});

describe("readBoldRuns", () => {
	it("splits a paragraph where bold starts and ends", () => {
		expect(
			readBoldRuns("**Research incomplete.** Two searches failed."),
		).toEqual([
			{ text: "Research incomplete.", bold: true },
			{ text: " Two searches failed.", bold: false },
		]);
		expect(readBoldRuns("See ***this*** and **that**:")).toEqual([
			{ text: "See ", bold: false },
			{ text: "this", bold: true },
			{ text: " and ", bold: false },
			{ text: "that", bold: true },
			{ text: ":", bold: false },
		]);
	});

	it("draws the same text as the plain PDF did", () => {
		for (const markdown of [
			"**Label.** Use `snake_case_name` and an _italic_ word.",
			"**Label.** ![Chart](chart.png) then *more*.",
			"Plain words only, with __bold__ in underscores.",
			"*a **b** c*",
			"**Sources.** https://example.com/a_b_c",
			"Revenue **↑**12% this quarter.",
			"**Café → résumé.** Done ≥ planned.",
		]) {
			expect(
				readBoldRuns(markdown)
					.map((run) => run.text)
					.join(""),
			).toBe(toWinAnsiText(stripInlineMarkdown(markdown)));
		}
	});

	it("keeps a paragraph regular where splitting at bold would change its text", () => {
		expect(readBoldRuns("*a **b** c*")).toEqual([
			{ text: "a b c", bold: false },
		]);
		expect(readBoldRuns("No bold here.")).toEqual([
			{ text: "No bold here.", bold: false },
		]);
		// A stand-in word is followed by a space only when the text after
		// it is drawn in the same string.
		expect(readBoldRuns("Revenue **↑**12% this quarter.")).toEqual([
			{ text: "Revenue up 12% this quarter.", bold: false },
		]);
	});

	it("reads no bold between ** markers that stand apart from the words", () => {
		const markdown = "2 ** 3 is 8 and 4 ** 2 is 16.";
		expect(readBoldRuns(markdown)).toEqual([
			{ text: toWinAnsiText(stripInlineMarkdown(markdown)), bold: false },
		]);
	});
});

describe("layOutPdfRuns", () => {
	const doc = new jsPDF({ unit: "pt", format: "a4" });
	doc.setFontSize(11);
	const measure = drawnWidth;
	const split = (text: string, bold: boolean, width: number): string[] => {
		doc.setFont("helvetica", bold ? "bold" : "normal");
		return doc.splitTextToSize(text, width);
	};

	it("keeps bold glued to punctuation together, with no space between", () => {
		const lines = layOutPdfRuns(
			[
				{ text: "Label", bold: true },
				{ text: ": the rest.", bold: false },
			],
			400,
			measure,
			split,
		);

		expect(lines).toEqual([
			[
				{ text: "Label", bold: true, x: 0 },
				{ text: ": the rest.", bold: false, x: measure("Label", true) },
			],
		]);
	});

	it("wraps at spaces and breaks a link wider than the line, every line inside the width", () => {
		const link = `https://example.com/${"report-section-".repeat(8)}end`;
		const width = 200;
		const lines = layOutPdfRuns(
			[
				{ text: "Sources.", bold: true },
				{ text: ` Read ${link} before sending.`, bold: false },
			],
			width,
			measure,
			split,
		);

		expect(lines.length).toBeGreaterThan(2);
		for (const line of lines) {
			const last = line[line.length - 1];
			expect(last.x + measure(last.text, last.bold)).toBeLessThanOrEqual(
				width,
			);
			for (const run of line) {
				expect(run.text).toBe(run.text.trim());
			}
		}
		expect(lines[0][0]).toEqual({ text: "Sources.", bold: true, x: 0 });
		const drawn = lines.flat().map((run) => run.text);
		expect(drawn.join("")).toContain(link);
		expect(drawn.join(" ")).toContain("before sending.");
	});
});

describe("regular downloads render blockquotes", () => {
	it("draws the PDF quote without its markers, indented, and the next paragraph at the margin", async () => {
		const pdf = await readBlobText(await renderMarkdownToPdf(notice));
		const blocks = drawnBlocks(pdf);
		const strings = blocks.flatMap((block) => block.strings);

		expect(strings.join(" ")).toContain("Research incomplete.");
		expect(strings.join(" ")).toContain(
			"Sources. Review them before sending.",
		);
		for (const drawn of strings) {
			expect(drawn).not.toMatch(/^\s*>/);
			expect(drawn).not.toContain("**");
		}
		const margin = xOf(blocks, "The analysis follows.");
		expect(xOf(blocks, "Research incomplete.")).toBeGreaterThan(margin);
		expect(xOf(blocks, "Sources.")).toBeGreaterThan(margin);
		expect(xOf(blocks, "Market context")).toBe(margin);
	});

	it("draws a PDF quote's bold label in bold and the words after it in the regular font, a space apart", async () => {
		const pdf = await readBlobText(await renderMarkdownToPdf(notice));
		const blocks = drawnBlocks(pdf);
		const bold = blockOf(blocks, "Market context").font;
		const regular = blockOf(blocks, "The analysis follows.").font;
		const label = blockOf(blocks, "Research incomplete.");
		const after = blockOf(blocks, "Two of the five searches");

		expect(bold).not.toBe(regular);
		expect(label.strings).toEqual(["Research incomplete."]);
		expect(label.font).toBe(bold);
		expect(after.font).toBe(regular);
		expect(blockOf(blocks, "Sources.").font).toBe(bold);
		expect(blockOf(blocks, "Review them before sending.").font).toBe(
			regular,
		);

		expect(after.x).toBeCloseTo(
			label.x +
				drawnWidth("Research incomplete.", true) +
				drawnWidth(" ", false),
			1,
		);
	});

	it("starts the words after a bold label one space past the label as drawn, kerning pairs included", async () => {
		const pdf = await readBlobText(
			await renderMarkdownToPdf(
				"> **Your Team.** Payroll and tax figures follow.",
			),
		);
		const blocks = drawnBlocks(pdf);
		const label = blockOf(blocks, "Your Team.");
		const after = blockOf(blocks, "Payroll and tax figures follow.");

		expect(label.strings).toEqual(["Your Team."]);
		expect(after.x).toBeCloseTo(
			label.x + drawnWidth("Your Team.", true) + drawnWidth(" ", false),
			1,
		);
	});

	it("draws each quote paragraph as its own block", async () => {
		const pdf = await readBlobText(await renderMarkdownToPdf(notice));
		const blocks = drawnBlocks(pdf);
		const holding = (text: string) =>
			blocks.findIndex((block) =>
				block.strings.some((drawn) => drawn.includes(text)),
			);

		expect(holding("Sources.")).toBeGreaterThan(
			holding("Research incomplete."),
		);
		expect(blocks[holding("Sources.")].strings.join(" ")).not.toContain(
			"Research incomplete.",
		);
	});

	it("keeps the bar beside every quote line when a quote crosses a PDF page", async () => {
		const markdown = [
			"## Long quote",
			"",
			...Array.from(
				{ length: 70 },
				(_, n) =>
					`> Quoted paragraph ${n + 1} about the example catalog.\n>`,
			),
			"",
			"The analysis follows.",
		].join("\n");

		const pdf = await readBlobText(await renderMarkdownToPdf(markdown));
		const bars = barsPerPage(pdf);
		const quoted = linesPerPage(pdf, "Quoted paragraph");

		expect(bars).toHaveLength(2);
		expect(quoted[0]).toBeGreaterThan(0);
		expect(quoted[1]).toBeGreaterThan(0);
		expect(bars).toEqual(quoted);
		expect(quoted[0] + quoted[1]).toBe(70);
	});

	it("leaves > lines inside a fenced code block as code, without quote styling", async () => {
		const markdown = [
			"Before the example.",
			"",
			"```text",
			"> not a quote",
			"> still code",
			"```",
			"",
			"After the example.",
		].join("\n");

		const pdf = await readBlobText(await renderMarkdownToPdf(markdown));
		const blocks = drawnBlocks(pdf);
		const strings = blocks.flatMap((block) => block.strings);

		expect(strings).toEqual(
			expect.arrayContaining(["> not a quote", "> still code"]),
		);
		expect(barsPerPage(pdf)).toEqual([0]);
		expect(xOf(blocks, "> not a quote")).not.toBe(
			xOf(blocks, "Before the example."),
		);
		expect(pdf).toMatch(/\/F\d+ 9 Tf[\s\S]*?\(> not a quote\) Tj/);

		await renderMarkdownToDocx(markdown, "Code");

		expect(
			recorder.paragraphs.filter((paragraph) => paragraph.bordered),
		).toEqual([]);
		expect(recorder.paragraphs).toEqual(
			expect.arrayContaining([
				{ text: "> not a quote", indented: false, bordered: false },
				{ text: "> still code", indented: false, bordered: false },
			]),
		);
	});

	it("builds DOCX quote paragraphs, indented with a left border, the label in bold", async () => {
		await renderMarkdownToDocx(notice, "Market context");

		const quoted = recorder.paragraphs.filter(
			(paragraph) => paragraph.bordered,
		);
		expect(quoted).toHaveLength(2);
		for (const paragraph of quoted) {
			expect(paragraph.indented).toBe(true);
		}
		expect(recorder.runs).toEqual(
			expect.arrayContaining([
				{ text: "Research incomplete.", bold: true },
				{ text: "Sources.", bold: true },
			]),
		);
		for (const run of recorder.runs) {
			expect(run.text).not.toMatch(/^\s*>/);
		}
	});

	it("leaves the DOCX paragraph after a quote as it was", async () => {
		await renderMarkdownToDocx(notice, "Market context");

		const after = recorder.paragraphs.find(
			(paragraph) => paragraph.text === "The analysis follows.",
		);
		expect(after).toEqual({
			text: "The analysis follows.",
			indented: false,
			bordered: false,
		});
	});

	it("keeps a > - item line in the quote rather than making it a bullet", async () => {
		const markdown = [
			"> - Checked the example catalog",
			"",
			"- A real item",
		].join("\n");
		await renderMarkdownToDocx(markdown, "List");

		expect(recorder.bullets).toBe(1);
		expect(
			recorder.paragraphs.filter((paragraph) => paragraph.bordered),
		).toEqual([
			{
				text: "- Checked the example catalog",
				indented: true,
				bordered: true,
			},
		]);

		const pdf = await readBlobText(await renderMarkdownToPdf(markdown));
		const blocks = drawnBlocks(pdf);
		// The quoted item keeps its dash at the quote's indent; the real
		// item is drawn as a bullet at the list's.
		expect(blocks.flatMap((block) => block.strings)).toContain(
			"- Checked the example catalog",
		);
		expect(xOf(blocks, "Checked the example catalog")).not.toBe(
			xOf(blocks, "A real item"),
		);
	});
});
