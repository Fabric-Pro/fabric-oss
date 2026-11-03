/**
 * Text the regular PDF download draws keeps every character and stays inside
 * the margins: an underscore inside a word is not emphasis, and a heading
 * longer than the line wraps instead of running off the page. The checks read
 * jsPDF's real, uncompressed output.
 */
import { jsPDF } from "jspdf";
import { describe, expect, it } from "vitest";
import { stripInlineMarkdown } from "../document-export-helpers";
import { renderMarkdownToPdf } from "../markdown-to-document";

function readBlobText(blob: Blob): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onloadend = () => resolve(reader.result as string);
		reader.onerror = reject;
		reader.readAsText(blob);
	});
}

/** Every string the PDF draws, from jsPDF's uncompressed content streams. */
async function drawnStrings(markdown: string): Promise<string[]> {
	const pdf = await readBlobText(await renderMarkdownToPdf(markdown));
	return [...pdf.matchAll(/\(((?:\\.|[^\\)])*)\) Tj/g)].map(
		(match) => match[1],
	);
}

describe("stripInlineMarkdown", () => {
	it("keeps underscores inside a word, as Markdown does", () => {
		expect(
			stripInlineMarkdown(
				"Set snake_case_name and MAX__RETRY__COUNT here",
			),
		).toBe("Set snake_case_name and MAX__RETRY__COUNT here");
	});

	it("still strips underscore emphasis around words", () => {
		expect(stripInlineMarkdown("An _italic_ and __bold__ word.")).toBe(
			"An italic and bold word.",
		);
		expect(
			stripInlineMarkdown("Use snake_case and _italic_ together"),
		).toBe("Use snake_case and italic together");
		expect(stripInlineMarkdown("Use _private_field here")).toBe(
			"Use _private_field here",
		);
	});

	it("strips emphasis around a word that holds an underscore", () => {
		expect(
			stripInlineMarkdown("Set __max_retries__ and _user_id_ now"),
		).toBe("Set max_retries and user_id now");
		expect(stripInlineMarkdown("A ___bold italic___ phrase")).toBe(
			"A bold italic phrase",
		);
		expect(stripInlineMarkdown("A __foo__bar__baz__ B")).toBe(
			"A foo__bar__baz B",
		);
	});

	it("strips a long single line in linear time", () => {
		// Each `_a` opens emphasis that never closes; a scan that retries to
		// the end of the line from every one of them takes seconds here.
		const lines = ["_a ".repeat(64_000), "__a ".repeat(48_000)];
		const started = performance.now();
		for (const line of lines) {
			expect(stripInlineMarkdown(line)).toBe(line);
		}

		expect(performance.now() - started).toBeLessThan(250);
	});
});

describe("regular PDF download text", () => {
	it("wraps an image placeholder wider than the line inside the margin", async () => {
		const alt = Array(12).fill("Quarterly delivery overview").join(" ");
		const lines = (await drawnStrings(`![${alt}](missing.png)`)).filter(
			(text) => `[Image: ${alt}]`.includes(text),
		);
		const measure = new jsPDF({ unit: "pt", format: "a4" });
		measure.setFont("helvetica", "italic");
		measure.setFontSize(10);

		expect(lines.join(" ")).toBe(`[Image: ${alt}]`);
		for (const line of lines) {
			expect(measure.getTextWidth(line)).toBeLessThanOrEqual(595.28 - 96);
		}
	});

	it("wraps a diagram placeholder wider than the line inside its box", async () => {
		const title = Array(10).fill("quarterly delivery overview").join(" ");
		const lines = (
			await drawnStrings(`\`\`\`mermaid\n${title}\n\`\`\``)
		).filter((text) => `[Diagram: ${title}]`.includes(text));
		const measure = new jsPDF({ unit: "pt", format: "a4" });
		measure.setFont("helvetica", "italic");
		measure.setFontSize(11);

		expect(lines.join(" ")).toBe(`[Diagram: ${title}]`);
		for (const line of lines) {
			expect(measure.getTextWidth(line)).toBeLessThanOrEqual(
				595.28 - 96 - 16,
			);
		}
	});

	it("draws an identifier with its underscores", async () => {
		expect(
			await drawnStrings("Rename the user_id_column field."),
		).toContain("Rename the user_id_column field.");
	});

	it("wraps a heading wider than the line, keeping all of its words inside the margin", async () => {
		const heading =
			"Example Org Platform Modernization Business Case for Regional Operations";
		const drawn = await drawnStrings(`# ${heading}\n\nBody text.`);
		const lines = drawn.filter((text) => heading.includes(text));
		const measure = new jsPDF({ unit: "pt", format: "a4" });
		measure.setFont("helvetica", "bold");
		measure.setFontSize(20);

		expect(lines.length).toBeGreaterThan(1);
		expect(lines.join(" ")).toBe(heading);
		for (const line of lines) {
			expect(measure.getTextWidth(line)).toBeLessThanOrEqual(595.28 - 96);
		}
	});
});
