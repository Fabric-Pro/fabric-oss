/**
 * Round-trip regression tests for feature documents: load (`fromMarkdown`) →
 * editor → save (`getEditorMarkdownForSave`), repeated. Every cycle must give
 * back the same markdown; anything that drifts accumulates in the stored
 * document each time an AI edit is accepted or the raw view is toggled.
 */

import { Editor } from "@tiptap/core";
import { describe, expect, it } from "vitest";
import { diffPartialText, fromMarkdown } from "../diff-utils";
import { getEditorMarkdownForSave } from "../editor-markdown-save";
import { advancedExtensions } from "../tiptap-extensions-advanced";

const ADD_START = "\u200B\u200BADD_START\u200B\u00A0";
const ADD_END = "\u00A0\u200BADD_END\u200B\u200B";

function saveEditorContent(content: string): { html: string; saved: string } {
	const editor = new Editor({ extensions: advancedExtensions, content });
	const html = editor.getHTML();
	const saved = getEditorMarkdownForSave(editor);
	editor.destroy();
	if (saved === null) {
		throw new Error("serialization failed");
	}
	return { html, saved };
}

function backslashCount(markdown: string): number {
	return (markdown.match(/\\/g) ?? []).length;
}

describe("editor markdown round trip: horizontal rules", () => {
	it("saves a rule as --- and keeps it a rule across load → save cycles", () => {
		// Arrange
		const markdown = "Intro paragraph.\n\n---\n\nOutro paragraph.";

		// Act
		const first = saveEditorContent(fromMarkdown(markdown));
		const second = saveEditorContent(fromMarkdown(first.saved));
		const third = saveEditorContent(fromMarkdown(second.saved));

		// Assert
		expect(first.saved).toMatch(/^---$/m);
		expect(first.saved).not.toContain("* * *");
		expect(second.html).toContain("<hr>");
		expect(third.html).toContain("<hr>");
		expect(second.saved).toBe(first.saved);
		expect(third.saved).toBe(first.saved);
	});
});

describe("editor markdown round trip: literal hyphen after a hard break", () => {
	it("keeps '- not a bullet' as paragraph text over three cycles", () => {
		// Arrange
		const editorHtml = "<p>Intro line<br>- not a bullet</p>";

		// Act
		const first = saveEditorContent(editorHtml);
		const cycles = [first];
		for (let i = 0; i < 3; i++) {
			const previous = cycles[cycles.length - 1];
			cycles.push(saveEditorContent(fromMarkdown(previous.saved)));
		}

		// Assert
		for (const cycle of cycles.slice(1)) {
			expect(cycle.html).not.toContain("<li>");
			expect(cycle.html).toContain("<br>");
			expect(cycle.html).toContain("- not a bullet");
			expect(cycle.saved).toBe(first.saved);
			expect(backslashCount(cycle.saved)).toBe(
				backslashCount(first.saved),
			);
		}
	});

	it("does not turn an escaped hyphen that continues a paragraph into a list", () => {
		// Arrange
		const markdown = "Intro line\n\\- not a bullet";

		// Act
		const html = fromMarkdown(markdown);

		// Assert
		expect(html).not.toContain("<li>");
		expect(html).toContain("- not a bullet");
	});

	it("still repairs escaped bullets that start a block", () => {
		// Arrange
		const atDocumentStart = "\\- first item\n\\- second item";
		const afterHeading = "## Scope\n\\- first item\n\\- second item";
		const afterBlankLine = "Intro.\n\n\\- first item\n\\- second item";

		// Act
		const htmls = [atDocumentStart, afterHeading, afterBlankLine].map(
			(markdown) => fromMarkdown(markdown),
		);

		// Assert
		for (const html of htmls) {
			expect((html.match(/<li>/g) ?? []).length).toBe(2);
			expect(html).not.toContain("\\-");
		}
	});
});

// The accept path: a completed AI edit is diffed against the baseline with
// `diffPartialText(baseline, next, true)` (which runs normalizeMarkdownForDiff),
// rendered with `fromMarkdown`, then saved from the editor.
function acceptAiEdit(
	baseline: string,
	next: string,
): { html: string; saved: string } {
	return saveEditorContent(
		fromMarkdown(diffPartialText(baseline, next, true)),
	);
}

describe("editor markdown round trip: hard breaks through an accepted AI edit", () => {
	it("keeps an unchanged hard break as a <br>", () => {
		// Arrange
		const baseline = "Intro line  \nsecond line";
		const next = `${baseline}\n\nAdded paragraph.`;

		// Act
		const { html, saved } = acceptAiEdit(baseline, next);

		// Assert
		expect(html).toContain("<br>");
		expect(saved).toContain("Intro line  \nsecond line");
		expect(saved).toContain("Added paragraph.");
	});

	it("keeps a hard break on a line the AI added", () => {
		// Arrange
		const baseline = "Intro.";
		const next = "Intro.\n\nAdded line  \nnext line";

		// Act
		const { html, saved } = acceptAiEdit(baseline, next);

		// Assert
		expect(html).toContain("<br>");
		expect(saved).toContain("Added line  \nnext line");
	});

	it("keeps '- not a bullet' after a hard break as paragraph text", () => {
		// Arrange
		const baseline = saveEditorContent(
			"<p>Intro line<br>- not a bullet</p>",
		).saved;
		const next = `${baseline}\n\nAdded paragraph.`;

		// Act
		const { html, saved } = acceptAiEdit(baseline, next);

		// Assert
		expect(html).not.toContain("<li>");
		expect(html).toContain("<br>");
		expect(html).toContain("- not a bullet");
		expect(saved.startsWith(baseline)).toBe(true);
	});
});

describe("editor markdown round trip: diff marker leftovers", () => {
	it("strips leftover marker characters on save and keeps ordinary non-breaking spaces", () => {
		// Arrange
		const editorHtml = `<p>Keep ${ADD_START}this${ADD_END} text\u200B\uFEFF and a\u00A0b.</p>`;

		// Act
		const { saved } = saveEditorContent(editorHtml);

		// Assert
		expect(saved).not.toMatch(/[\u200B\uFEFF]/);
		expect(saved).not.toContain("ADD_START");
		expect(saved).not.toContain("ADD_END");
		expect(saved).toContain("this");
		expect(saved).toContain("a\u00A0b.");
	});
});

describe("editor typography", () => {
	it("leaves quotes straight while keeping the other typography rules", () => {
		// Arrange
		const editor = new Editor({ extensions: advancedExtensions });

		// Act
		const typography = editor.extensionManager.extensions.find(
			(extension) => extension.name === "typography",
		);
		editor.destroy();

		// Assert
		expect(typography?.options).toMatchObject({
			openDoubleQuote: false,
			closeDoubleQuote: false,
			openSingleQuote: false,
			closeSingleQuote: false,
			emDash: "—",
		});
	});
});
