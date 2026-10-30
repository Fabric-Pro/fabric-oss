/**
 * Round-trip regression tests for feature documents: load (`fromMarkdown`) →
 * editor → save (`getEditorMarkdownForSave`), repeated. Every cycle must give
 * back the same markdown; anything that drifts accumulates in the stored
 * document each time an AI edit is accepted or the raw view is toggled.
 */

import { Editor } from "@tiptap/core";
import { describe, expect, it } from "vitest";
import {
	diffPartialText,
	fromMarkdown,
	repairMarkdownDocument,
} from "../diff-utils";
import { getEditorMarkdownForSave } from "../editor-markdown-save";
import {
	advancedExtensions,
	createAdvancedExtensions,
} from "../tiptap-extensions-advanced";

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
// rendered with `fromMarkdown` as StoryWorkspace renders it, then saved from
// the editor.
function acceptAiEdit(
	baseline: string,
	next: string,
): { html: string; saved: string } {
	return saveEditorContent(
		fromMarkdown(diffPartialText(baseline, next, true), {
			repairLegacyBullets: false,
		}),
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

describe("diff review: an AI edit that changes a paragraph's block role", () => {
	const paragraph =
		"Provide a repeatable export. Later exports replace the same file.";

	it("shows a paragraph turned into a list item as a visible old/new pair", () => {
		// Arrange
		const baseline = `### Overview\n\n${paragraph}\n\nClosing note.`;
		const next = `### Overview\n\n- ${paragraph} Files are UTF-8.\n\nClosing note.`;

		// Act
		const html = fromMarkdown(diffPartialText(baseline, next, true));
		const { saved } = acceptAiEdit(baseline, next);

		// Assert
		expect(html).not.toContain('<ins class="diff-ins"></ins>');
		expect(html).toMatch(/<del[^>]*>Provide a repeatable export\./);
		expect(html).toMatch(/<li><ins class="diff-ins">Provide a repeatable/);
		expect(saved).toContain(`-   ${paragraph} Files are UTF-8.`);
		expect(saved.match(/Provide a repeatable/g)).toHaveLength(1);
	});

	it("shows a paragraph turned into a heading as a visible old/new pair", () => {
		// Arrange
		const baseline = "Intro.\n\nExport settings\n\nClosing note.";
		const next = "Intro.\n\n## Export settings\n\nClosing note.";

		// Act
		const html = fromMarkdown(diffPartialText(baseline, next, true));

		// Assert
		expect(html).not.toContain('<ins class="diff-ins"></ins>');
		expect(html).toMatch(/<del[^>]*>Export settings/);
		expect(html).toMatch(/<h2><ins class="diff-ins">Export settings/);
	});

	it("still hoists the prefix of a list item the AI added whole", () => {
		// Arrange
		const baseline = "- First item";
		const next = "- First item\n- Second item";

		// Act
		const html = fromMarkdown(diffPartialText(baseline, next, true));

		// Assert
		expect(html).toMatch(/<li><ins class="diff-ins">Second item/);
		expect(html).not.toContain("<del");
	});
});

// What accepting an AI edit must save: exactly what loading the AI's document
// straight into the editor saves. Stored content loads without the legacy
// bullet repair, as StoryWorkspace loads it.
function loadDirect(markdown: string): string {
	return saveEditorContent(
		fromMarkdown(markdown, { repairLegacyBullets: false }),
	).saved;
}

const RELEASE_NOTE =
	"If you reject all proposed changes in Thorough mode, the item is removed from the inbox and a note is added to the Decisions tab.";
const TABLE =
	"| Field | Type | Notes |\n| --- | --- | --- |\n| id | string | primary key |\n| name | string | display name |";

describe("accepting an AI edit saves the AI's document", () => {
	it.each([
		{
			name: "a bullet added above a horizontal rule keeps the rule",
			baseline: "- Item one\n- Item two\n\n---\n\n### Steps",
			next: "- Item one\n- Item two\n- New **important** line.\n\n---\n\n### Steps",
		},
		{
			name: "a sentence appended to a nested item keeps the next item nested",
			baseline:
				"- Parent\n  - Nested detail one\n  - Nested detail two\n\n---",
			next: "- Parent\n  - Nested detail one in Fast mode, added sentence.\n  - Nested detail two\n\n---",
		},
		{
			name: "replacing a hyphenated word leaves no dangling hyphen and keeps the nested list",
			baseline:
				"- A re-runnable export that is up-to-date.\n  - Nested detail one\n  - Nested detail two\n\n---",
			next: "- A re-runnable export that is in Fast mode\n  - Nested detail one\n  - Nested detail two\n\n---",
		},
		{
			name: "two adjacent edited lines are diffed line by line",
			baseline:
				"- A re-runnable export that is up-to-date.\n  - Nested detail one\n  - Nested detail two",
			next: "- A re-runnable export that is **important**\n  - Nested now one\n  - Nested detail two",
		},
		{
			name: "two lines added to one paragraph keep the space between them",
			baseline: "## Overview\n\nIntro sentence.\n\n### Next",
			next: "## Overview\n\nIntro sentence.\nNew re-run line.\nNew well-known line.\n\n### Next",
		},
		{
			name: "a release note bullet edited mid-sentence stays one bullet",
			baseline: `### Release Notes\n\n- ${RELEASE_NOTE}\n\nView in Fabric`,
			next: `### Release Notes\n\n- ${RELEASE_NOTE.replace(
				"a note is added to the Decisions tab.",
				"a note is still added to the Decisions tab confirming no changes were applied.",
			)}\n\nView in Fabric`,
		},
		{
			name: "an edited table cell",
			baseline: `Intro.\n\n${TABLE}\n\nOutro.`,
			next: `Intro.\n\n${TABLE.replace("display name", "human readable name")}\n\nOutro.`,
		},
		{
			name: "an added table row",
			baseline: `Intro.\n\n${TABLE}\n\nOutro.`,
			next: `Intro.\n\n${TABLE}\n| email | string | unique |\n\nOutro.`,
		},
		{
			name: "an inline answer next to a bold question in a numbered list",
			baseline:
				"### Open Questions\n\n1. **Which format?** TBD\n2. **Who owns it?** TBD",
			next: "### Open Questions\n\n1. **Which format?** CSV, UTF-8.\n2. **Who owns it?** The PM.",
		},
		{
			name: "an item inserted into a numbered list",
			baseline: "1. First step\n2. Second step\n3. Third step",
			next: "1. First step\n2. New step\n3. Second step\n4. Third step",
		},
		{
			name: "an edited H3 heading",
			baseline:
				"### Open Questions\n\nSome text.\n\n### Risks\n\nMore text.",
			next: "### Open Questions\n\nSome text.\n\n### Risks and Mitigations\n\nMore text.",
		},
		{
			name: "a line edited inside a code block",
			baseline: "Example:\n\n```ts\nconst a = 1;\n```\n\nDone.",
			next: "Example:\n\n```ts\n- const a = 1;\n```\n\nDone.",
		},
		{
			name: "a whole bullet deleted",
			baseline: "- One\n- Two\n- Three\n\nAfter.",
			next: "- One\n- Three\n\nAfter.",
		},
		{
			name: "a nested bullet re-wrapped while the line above changes",
			baseline:
				"- A re-runnable export that is up-to-date.\n  - Nested detail one\n  - Nested detail two",
			next: "- A re-runnable export that is now up-to-date.\n  - Nested detail\n    one\n  - Nested detail two",
		},
		{
			name: "a bullet added next to an edited neighbour",
			baseline:
				"- **Owner:** Product\n- A well-known, re-runnable export that is up-to-date.\n  - Nested detail one",
			next: "- **Owner:** Product\n- A well-known, re-runnable export that is and up-to-date.\n- New CSV, UTF-8. line.\n  - Nested detail one",
		},
		{
			name: "a paragraph between two lists turned into a bullet",
			baseline: "- One\n- Two\n\nand\n\n- Three",
			next: "- One\n- Two\n\n- and\n\n- Three",
		},
		{
			name: "a paragraph between two lists deleted",
			baseline: "- One\n\nMiddle para.\n\n1. First",
			next: "- One\n\n1. First",
		},
		{
			name: "a parent bullet deleted with its nested items kept",
			baseline:
				"- Note one.\n- **Owner:** Product\n  - Nested one\n  - Nested two\n\n### Next",
			next: "- Note one.\n  - Nested one\n  - Nested two\n\n### Next",
		},
		{
			name: "a parent bullet deleted after an item that has nested items",
			baseline:
				"- Note one.\n  - Child a\n- **Owner:** Product\n  - Nested one\n\n### Next",
			next: "- Note one.\n  - Child a\n  - Nested one\n\n### Next",
		},
		{
			name: "a later numbered item deleted after a paragraph",
			baseline:
				"Intro paragraph.\n\n2. Accept or reject each change\n\nOutro.",
			next: "Intro paragraph.\n\nOutro.",
		},
		{
			name: "the first item of a numbered list deleted",
			baseline: "1. Open the inbox\n2. Choose a mode\n3. Accept",
			next: "2. Choose a mode\n3. Accept",
		},
		// A link is the outer mark of deleted linked text (Fizzy #2946).
		{
			name: "a bullet that is only a link deleted",
			baseline:
				"- First\n- [Report link](https://example.com/report)\n- Third",
			next: "- First\n- Third",
		},
		{
			name: "a bullet of text and a link deleted",
			baseline:
				"- First\n- See [the report](https://example.com/report)\n- Third",
			next: "- First\n- Third",
		},
		{
			name: "the first item of a numbered list deleted, a link",
			baseline:
				"1. [Open the inbox](https://example.com/inbox)\n2. Choose a mode\n3. Accept",
			next: "2. Choose a mode\n3. Accept",
		},
		{
			name: "a link deleted from a bullet that keeps its other text",
			baseline:
				"- First\n- See [the report](https://example.com/report) now\n- Third",
			next: "- First\n- See now\n- Third",
		},
		{
			name: "a YAML line split onto an indented line inside a code block",
			baseline:
				"Intro.\n\n```yaml\n- name: build\n- run: test\n```\n\nDone.",
			next: "Intro.\n\n```yaml\n- name:\n  build\n- run: test\n```\n\nDone.",
		},
		{
			name: "a code line split in two",
			baseline: "Intro.\n\n```ts\nconst a = 1;\n```\n\nDone.",
			next: "Intro.\n\n```ts\nconst a =\n1;\n```\n\nDone.",
		},
		{
			name: "a code line starting with a dash deleted",
			baseline: "Intro.\n\n```ts\nconst x = 1;\n- a\n= b\n```\n\nDone.",
			next: "Intro.\n\n```ts\nconst x = 1;\n= b\n```\n\nDone.",
		},
	])("$name", ({ baseline: raw, next }) => {
		// Arrange
		const baseline = loadDirect(raw);

		// Act
		const { saved } = acceptAiEdit(baseline, next);

		// Assert
		expect(saved).toBe(loadDirect(next));
	});

	it("does not degrade a document over repeated accepted edits", () => {
		// Arrange
		const document = loadDirect(
			[
				"## Overview",
				"Reviewing an update shows a summary before anything is applied.",
				"### Release Notes",
				`- ${RELEASE_NOTE}`,
				"- **Owner:** Product\n  - Nested detail one\n  - Nested detail two",
				"---",
				"1. Open the inbox\n2. Choose **Thorough** mode",
				TABLE,
				'> A quoted note about "quotes" and it\'s fine.',
				"```ts\nconst a = 1;\n```",
				"Closing paragraph.",
			].join("\n\n"),
		);

		// Act
		let current = document;
		for (let pass = 1; pass <= 3; pass++) {
			current = acceptAiEdit(
				current,
				`${current}\n\nAdded in pass ${pass}.`,
			).saved;
		}

		// Assert
		expect(current).toBe(
			`${document}\n\nAdded in pass 1.\n\nAdded in pass 2.\n\nAdded in pass 3.`,
		);
		expect(current).not.toMatch(/[​﻿“”‘’]/);
		expect(backslashCount(current)).toBe(backslashCount(document));
	});

	it("saves the AI's document on every pass of a long session of mixed edits", () => {
		// Arrange
		const edits: Array<(document: string) => string> = [
			(document) =>
				document.replace("a note is added", "a note is still added"),
			(document) =>
				document.replace(
					"Nested detail two",
					"Nested detail\n        two",
				),
			(document) => document.replace("| primary key |", "| unique id |"),
			(document) => document.replace("### Steps", "### Steps to follow"),
			(document) => document.replace("const a = 1;", "const a =\n1;"),
			(document) =>
				document.replace("Closing paragraph.", "- Closing paragraph."),
			(document) => document.replace("2.  Choose", "2.  Then choose"),
			(document) =>
				document.replace(/- {3}\*\*Owner:\*\* Product\n *\n/, ""),
		];
		let current = loadDirect(
			[
				"## Overview",
				"### Release Notes",
				`- ${RELEASE_NOTE}`,
				"- **Owner:** Product\n  - Nested detail one\n  - Nested detail two",
				"### Steps",
				"1. Open the inbox\n2. Choose **Thorough** mode",
				TABLE,
				"```ts\nconst a = 1;\n```",
				"Closing paragraph.",
			].join("\n\n"),
		);

		for (const edit of edits) {
			// Act
			const next = edit(current);
			const { saved } = acceptAiEdit(current, next);

			// Assert
			expect(next).not.toBe(current);
			expect(saved).toBe(loadDirect(next));
			current = saved;
		}
		expect(current).not.toMatch(/[​﻿“”‘’]/);
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

/**
 * The editor's load path, as a stored document takes it: repaired, rendered,
 * read by the editor, then saved.
 */
function loadAndSave(markdown: string): { html: string; saved: string } {
	return saveEditorContent(fromMarkdown(repairMarkdownDocument(markdown)));
}

describe("editor markdown round trip: fences (Fizzy #2946)", () => {
	it("keeps a fence's language as spelled across load → save cycles", () => {
		// The load repair lowercased it, so a body saved as ```Cards loaded
		// as ```cards and the next save changed it with no edit.
		const markdown =
			"## Options\n\n```Cards\n- First option\n- Second option\n```\n\n```TypeScript\nconst a = 1;\n```\n\nAfter.";

		const first = loadAndSave(markdown);
		const second = loadAndSave(first.saved);

		expect(first.saved).toBe(markdown);
		expect(second.saved).toBe(first.saved);
	});

	it.each([
		{ editor: "without the stat tiles node", statTiles: false },
		{ editor: "with the stat tiles node", statTiles: true },
	])(
		"keeps a block fence spelled with capitals as code, unchanged ($editor)",
		({ statTiles }) => {
			// Only the lowercase spelling is a block (the stat tiles node matches
			// `language-stat-tiles`); another spelling stays the code it was.
			const markdown =
				"## Results\n\n```Stat-Tiles\n42% | Faster onboarding\n```\n\n```Columns\nLeft | Right\n```\n\nAfter.";
			const extensions = createAdvancedExtensions({
				projectId: null,
				documentId: null,
				statTiles,
			});
			const cycle = (body: string) => {
				const editor = new Editor({
					extensions,
					content: fromMarkdown(repairMarkdownDocument(body)),
				});
				const saved = getEditorMarkdownForSave(editor);
				editor.destroy();
				return saved;
			};

			const first = cycle(markdown);

			expect(first).toBe(markdown);
			expect(cycle(first ?? "")).toBe(first);
		},
	);

	it("keeps a mermaid fence's language as spelled through the load repair", () => {
		// The diagram node itself saves every diagram as ```mermaid; the
		// repair before it no longer changes the spelling on its own.
		const markdown = "## Flow\n\n```Mermaid\nflowchart LR\n  A --> B\n```";

		expect(repairMarkdownDocument(markdown)).toContain("```Mermaid\n");
	});

	it.each([
		{
			name: "a diagram",
			markdown:
				"## Flow\n\n> A note before it.\n>\n> ```mermaid\n> flowchart LR\n>   A --> B\n> ```\n\nAfter.",
			fence: "> ```mermaid",
		},
		{
			name: "a code block",
			markdown: "## Example\n\n> ```js\n> const a = 1;\n> ```\n\nAfter.",
			fence: "> ```js",
		},
	])(
		"keeps $name inside its blockquote across load → save cycles",
		({ markdown, fence }) => {
			// The load repair moved each ``` onto a line of its own, out of the
			// quote: the block loaded as code whose lines began with `>`.
			const first = loadAndSave(markdown);
			const second = loadAndSave(first.saved);

			expect(first.html).toMatch(
				/<blockquote>(?:(?!<\/blockquote>).)*<pre/s,
			);
			expect(first.saved).toContain(`${fence}\n`);
			expect(first.saved).toMatch(/^> ```$/m);
			expect(first.saved).not.toMatch(/^```/m);
			expect(first.saved).not.toContain("\n> >");
			expect(second.saved).toBe(first.saved);
		},
	);
});
