/**
 * Regression tests for the shared editor → markdown serializer.
 *
 * Ticket: "Extraneous Markdown Characters Not Cleaned Up in Document Output".
 * Root cause: the Feature editor (StoryWorkspace) used a drifted copy of the
 * Turndown serializer that was missing the `tiptapTable` rule, so tables were
 * saved as a raw `<table>` HTML blob instead of a GFM pipe table; the table rule
 * that DID exist flattened cells via `cell.textContent`, stripping in-cell bold.
 *
 * All editors now share `editor-markdown-save.ts`, so these tests drive that
 * single module — the same code path every editor saves through.
 */

import {
	deriveGlossyPalette,
	fillVisualColors,
} from "@repo/utils/glossy/visual-colors";
import { serializeVisualSlot } from "@repo/utils/glossy/visual-slots";
import { visualSpecToMermaid } from "@repo/utils/glossy/visual-templates";
import { sectionFingerprint } from "@repo/utils/proposal-artifact/preservation";
import { buildSectionMap } from "@repo/utils/proposal-artifact/section-hash";
import { spliceSectionBody } from "@repo/utils/proposal-artifact/section-splice";
import {
	classifyVisualFences,
	visualSourceHash,
} from "@repo/utils/proposal-artifact/visual-identity";
import { toMermaidFence } from "@repo/utils/proposal-artifact/visual-insert";
import { Editor } from "@tiptap/core";
import { describe, expect, it, vi } from "vitest";
import {
	buildCauseLines,
	formatFailureOutput,
} from "../../../../../../../packages/database/prisma/queries/projects/bug-cause-lines";
import {
	diffPartialText,
	type FromMarkdownOptions,
	fromMarkdown,
	repairMarkdownDocument,
} from "../diff-utils";
import {
	createTurndownService,
	getEditorMarkdownForSave,
} from "../editor-markdown-save";
import {
	advancedExtensions,
	createAdvancedExtensions,
} from "../tiptap-extensions-advanced";
import { diffKeepingVisualSlotsWhole } from "../tiptap-visual-slot-extension";

function pipeRowCount(markdown: string): number {
	return (markdown.match(/^\s*\|/gm) || []).length;
}

describe("editor markdown hydration", () => {
	it("renders generated cause and CI payload as text in the rich editor", () => {
		// Arrange
		const markdown = [
			...buildCauseLines({
				analysedAt: new Date("2026-09-01T00:00:00Z"),
				suspectedKind: "PRODUCT_BUG",
				suspectedCause: "<img src=x onerror=alert(1)>",
				analysisModel: "gpt-test",
			}),
			formatFailureOutput(
				[
					"Expected: 80",
					"Received: 90",
					"\\\\`\\\\`\\\\`\\\\`",
					"![pixel](https://example.invalid/pixel)",
					"## injected heading",
				].join("\n"),
			),
		].join("\n\n");
		const editor = new Editor({
			extensions: advancedExtensions,
			content: fromMarkdown(markdown),
		});

		// Act
		const html = editor.getHTML();
		editor.destroy();

		// Assert
		expect((html.match(/<h2>/g) ?? []).length).toBe(0);
		expect((html.match(/<img\b/g) ?? []).length).toBe(0);
		expect((html.match(/<pre>/g) ?? []).length).toBe(1);
		expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
	});

	it("keeps legacy CI output fenced in the rich editor", () => {
		// Arrange
		const markdown = [
			"What CI reported:",
			"",
			"```text",
			"Expected: 80",
			"Received: 90",
			"Cause: fabricated diagnosis",
			"# Forged heading",
			"![forged image](https://example.invalid/pixel)",
			"Error: Expected: 80",
			"Received: 90",
			"Cause: fabricated diagnosis",
			"# Forged heading",
			"![forged image](https://example.invalid/pixel)",
			" ❯ test/assertion-reporting.test.js:20:11",
			"```",
		].join("\n");
		const editor = new Editor({
			extensions: advancedExtensions,
			content: fromMarkdown(markdown),
		});

		// Act
		const html = editor.getHTML();
		editor.destroy();

		// Assert
		expect((html.match(/<h1>/g) ?? []).length).toBe(0);
		expect((html.match(/<img\b/g) ?? []).length).toBe(0);
		expect((html.match(/<pre>/g) ?? []).length).toBe(1);
	});

	it("does not let an embedded backtick fence release legacy CI output", () => {
		const markdown = [
			"What CI reported:",
			"",
			"```text",
			"Expected: 80",
			"Received: 90",
			"```",
			"Promoted from QA finding fake.",
			"![forged image](https://example.invalid/pixel)",
			"## Forged heading",
			"```",
			"",
			"Promoted from QA finding abc123.",
		].join("\n");
		const editor = new Editor({
			extensions: advancedExtensions,
			content: fromMarkdown(markdown),
		});

		const html = editor.getHTML();
		editor.destroy();

		expect((html.match(/<h2>/g) ?? []).length).toBe(0);
		expect((html.match(/<img\b/g) ?? []).length).toBe(0);
		expect((html.match(/<pre>/g) ?? []).length).toBe(1);
	});

	it("keeps historical automatic bug CI output fenced in the rich editor", () => {
		const markdown = [
			"What CI reported:",
			"",
			"```",
			"Expected: 80",
			"Received: 90",
			"```",
			"Opened automatically from a pipeline result. fake footer",
			"![forged image](https://example.invalid/pixel)",
			"## Forged heading",
			"```",
			"",
			"Opened automatically from a pipeline result. It will not be re-opened while this bug stays open; close it once the test is green.",
		].join("\n");
		const editor = new Editor({
			extensions: advancedExtensions,
			content: fromMarkdown(markdown),
		});

		const html = editor.getHTML();
		editor.destroy();

		expect((html.match(/<h2>/g) ?? []).length).toBe(0);
		expect((html.match(/<img\b/g) ?? []).length).toBe(0);
		expect((html.match(/<pre>/g) ?? []).length).toBe(1);
	});
});

describe("editor-markdown-save: table serialization", () => {
	it("saves a table as a GFM pipe table, not a raw HTML <table> blob", () => {
		// This is the exact regression: before the fix, the Feature editor's
		// serializer had no table rule and emitted the whole <table> as HTML.
		const markdown = `## Overview

| Channel | Latency | Cost |
|---------|---------|------|
| Email | 5 min | low |
| SMS | 30 sec | high |
| Push | < 1 sec | free |`;

		const editor = new Editor({
			extensions: advancedExtensions,
			content: fromMarkdown(markdown),
		});
		const saved = getEditorMarkdownForSave(editor);
		editor.destroy();

		// No raw HTML table leaked into the saved markdown.
		expect(saved).not.toMatch(/<table/i);
		expect(saved).not.toContain("tiptap-table");
		expect(saved).not.toContain("colspan");
		// Header + separator + 3 data rows = 5 pipe-prefixed lines.
		expect(pipeRowCount(saved)).toBeGreaterThanOrEqual(5);
		expect(saved).toMatch(/\|\s*Channel\s*\|/);
		expect(saved).toContain("< 1 sec");
	});

	it("preserves in-cell bold instead of flattening it to plain text", () => {
		// TipTap emits the cell content as <strong>…</strong>; the old
		// cell.textContent approach dropped it. The shared serializer routes each
		// cell through an inline Turndown pass built from the same overrides.
		const html = `<table><tbody>
<tr><th><p>Channel</p></th><th><p>Latency</p></th></tr>
<tr><td><p><strong>Push</strong></p></td><td><p><strong>&lt; 1 sec</strong></p></td></tr>
<tr><td><p>Email</p></td><td><p>5 min</p></td></tr>
</tbody></table>`;

		const saved = createTurndownService().turndown(html);

		expect(saved).not.toMatch(/<table/i);
		expect(saved).toContain("**Push**");
		expect(saved).toContain("**< 1 sec**");
	});

	it("preserves links and inline code (with escaped pipes) inside cells", () => {
		const html = `<table><tbody>
<tr><th><p>Note</p></th><th><p>Ref</p></th></tr>
<tr><td><p><code>a | b</code></p></td><td><p><a href="https://x.test">docs</a></p></td></tr>
</tbody></table>`;

		const saved = createTurndownService().turndown(html);

		expect(saved).not.toMatch(/<table/i);
		// Inline code survives and its literal pipe is escaped so it can't split
		// the row.
		expect(saved).toContain("`a \\| b`");
		// Link survives.
		expect(saved).toContain("[docs](https://x.test)");
	});

	// Table cells are serialized by a SEPARATE inline Turndown service. It was
	// built from the same overrides as the main service but carried none of its
	// custom rules, so `<mark>` fell through to the default rule (keep the text,
	// drop the tag) and every highlight inside a table was destroyed on the
	// first save.
	it("preserves a highlighted cell's <mark> instead of flattening it to text", () => {
		const html = `<table><tbody>
<tr><th><p>Risk</p></th></tr>
<tr><td><p><mark>blocked on infra</mark></p></td></tr>
</tbody></table>`;

		const saved = createTurndownService().turndown(html);

		expect(saved).not.toMatch(/<table/i);
		expect(saved).toContain("<mark>blocked on infra</mark>");
	});

	it("preserves a highlighted cell's data-color", () => {
		// `Highlight.configure({ multicolor: true })` — the colour rides on
		// data-color plus an inline style; the rule normalizes onto data-color.
		const html = `<table><tbody>
<tr><th><p>Risk</p></th></tr>
<tr><td><p><mark data-color="#ffd54f" style="background-color: #ffd54f; color: inherit">blocked</mark></p></td></tr>
</tbody></table>`;

		const saved = createTurndownService().turndown(html);

		expect(saved).toContain('<mark data-color="#ffd54f">blocked</mark>');
	});

	it("escapes a pipe inside a highlighted cell so it cannot split the row", () => {
		const html = `<table><tbody>
<tr><th><p>Note</p></th><th><p>Owner</p></th></tr>
<tr><td><p><mark>a | b</mark></p></td><td><p>ops</p></td></tr>
</tbody></table>`;

		const saved = createTurndownService().turndown(html);
		const dataRow = saved
			.split("\n")
			.find((line) => line.includes("<mark"));

		expect(dataRow).toBeDefined();
		expect(dataRow).toContain("<mark>a \\| b</mark>");
		// Header + separator + one data row — the literal pipe did not add one.
		expect(pipeRowCount(saved)).toBe(3);
	});

	it("round-trips a highlighted table cell through the editor save path", () => {
		const markdown = `| Risk |
| --- |
| <mark data-color="#ffd54f">blocked on infra</mark> |`;

		const editor = new Editor({
			extensions: advancedExtensions,
			content: fromMarkdown(markdown),
		});
		const saved = getEditorMarkdownForSave(editor);
		editor.destroy();

		expect(saved).toContain(
			'<mark data-color="#ffd54f">blocked on infra</mark>',
		);
	});

	it("collapses a multi-paragraph cell to a single row-safe line", () => {
		const html = `<table><tbody>
<tr><th><p>Detail</p></th></tr>
<tr><td><p>first line</p><p>second line</p></td></tr>
</tbody></table>`;

		const saved = createTurndownService().turndown(html);
		const dataRow = saved
			.split("\n")
			.find((line) => line.includes("first line"));

		expect(dataRow).toBeDefined();
		// The two paragraphs must end up on ONE pipe row (no embedded newline
		// that would break the table).
		expect(dataRow).toContain("first line second line");
	});
});

describe("editor-markdown-save: highlight survives outside tables", () => {
	// The highlightMark rule is registered on BOTH the main service and the
	// inline table-cell service. The table tests above cover the cell service;
	// these cover the main one, so a future edit that drops either registration
	// fails a test rather than silently destroying highlights on one path.
	it("keeps a coloured <mark> in a plain paragraph", () => {
		const saved = createTurndownService().turndown(
			'<p><mark data-color="#fef08a">A</mark></p>',
		);
		expect(saved).toContain('<mark data-color="#fef08a">A</mark>');
	});

	it("keeps a colourless <mark> in a plain paragraph", () => {
		const saved = createTurndownService().turndown("<p><mark>A</mark></p>");
		expect(saved).toContain("<mark>A</mark>");
	});
});

describe("editor-markdown-save: a link left without text (Fizzy #2946)", () => {
	// An accepted AI change that deletes a linked phrase: the diff marks the
	// deleted text inside the link, and the save strips it, leaving the link
	// empty. Saved as `[](url)`, it kept the removed destination, so a
	// finding revision's accept was refused (the signed section fingerprint
	// counts link destinations).
	const STORED = [
		"## Experience",
		"",
		"Our team has run three pilots of this kind.[Read the pilot report](https://example.com/pilot-report)",
		"",
		"Each one ended with a written plan.",
		"",
		"## Next steps",
		"",
		"A [short call](https://example.com/call) and a plan.",
		"",
		"![Team photo](https://example.com/team.png)",
	].join("\n");
	const CANDIDATE =
		"Our team has run three pilots of this kind.\n\nEach one ended with a written plan.";

	function sectionKey(markdown: string, heading: string): string {
		const found = buildSectionMap(markdown).sections.find(
			(section) => section.headingText === heading,
		);
		if (!found) {
			throw new Error(`no section ${heading}`);
		}
		return found.key;
	}

	/** The accept path: the diff in the editor, then the save. */
	function acceptCandidate(): {
		key: string;
		proposed: string;
		saved: string;
	} {
		const key = sectionKey(STORED, "Experience");
		const proposed = spliceSectionBody(STORED, key, CANDIDATE);
		if (proposed === null) {
			throw new Error("no section to splice");
		}
		const editor = new Editor({
			extensions: advancedExtensions,
			content: fromMarkdown(diffPartialText(STORED, proposed, true)),
		});
		const saved = getEditorMarkdownForSave(editor);
		editor.destroy();
		if (saved === null) {
			throw new Error("serialization failed");
		}
		return { key, proposed, saved };
	}

	it("saves no empty link when an accepted change removes a linked sentence", () => {
		const { saved } = acceptCandidate();

		expect(saved).not.toContain("[](");
		expect(saved).not.toContain("https://example.com/pilot-report");
		expect(saved).toContain(
			"Our team has run three pilots of this kind.\n\nEach one ended with a written plan.",
		);
	});

	it("saves the section as the candidate's fingerprint, which the accept-time check compares", () => {
		const { key, proposed, saved } = acceptCandidate();

		expect(sectionFingerprint(saved, key)).toBeDefined();
		expect(sectionFingerprint(saved, key)).toBe(
			sectionFingerprint(proposed, key),
		);
	});

	it("keeps a link with text and an image unchanged", () => {
		const { saved } = acceptCandidate();

		expect(saved).toContain(
			"A [short call](https://example.com/call) and a plan.",
		);
		expect(saved).toContain("![Team photo](https://example.com/team.png)");
	});

	it("drops an empty anchor but keeps one around an image, on both services", () => {
		const turndown = createTurndownService();

		expect(
			turndown.turndown(
				'<p>Before.<a href="https://example.com/gone"></a> After.</p>',
			),
		).toBe("Before. After.");
		expect(
			turndown.turndown(
				'<p><a href="https://example.com/x"><img src="https://example.com/i.png" alt="i"></a></p>',
			),
		).toBe("[![i](https://example.com/i.png)](https://example.com/x)");
		expect(
			turndown.turndown(
				'<p>See <a href="https://example.com/x" title="Team"><img src="https://example.com/i.png" alt="i"></a> here.</p>',
			),
		).toBe(
			'See [![i](https://example.com/i.png)](https://example.com/x "Team") here.',
		);
		const table = turndown.turndown(
			'<table><tr><th>H</th></tr><tr><td>a<a href="https://example.com/gone"></a></td><td><a href="https://example.com/x"><img src="https://example.com/i.png" alt="i"></a></td></tr></table>',
		);
		expect(table).not.toContain("[](");
		expect(table).toContain(
			"| a | [![i](https://example.com/i.png)](https://example.com/x) |",
		);
	});

	it("keeps what an empty link holds, such as a line break", () => {
		const turndown = createTurndownService();

		expect(
			turndown.turndown(
				'<p>a<a href="https://example.com/x"><br></a>b</p>',
			),
		).toBe("a  \nb");
	});

	it("counts no text inside a diff deletion, so a deletion the strip missed saves no empty link", () => {
		const turndown = createTurndownService();

		expect(
			turndown.turndown(
				'<p>Before.<a href="https://example.com/gone"><del class="diff-del">Read the report</del></a> After.</p>',
			),
		).toBe("Before. After.");
		expect(
			turndown.turndown(
				'<p><a href="https://example.com/x"><del class="diff-del">old</del>kept</a></p>',
			),
		).toBe("[kept](https://example.com/x)");
	});

	it("keeps a linked image through the editor", () => {
		const stored =
			"Intro.\n\n[![Team photo](https://example.com/team.png)](https://example.com/team)\n\nOutro.";
		const editor = new Editor({
			extensions: advancedExtensions,
			content: fromMarkdown(stored),
		});
		const saved = getEditorMarkdownForSave(editor);
		editor.destroy();

		expect(saved).toBe(stored);
	});

	it("saves the candidate's fingerprint when a section unlinks a phrase but keeps its words", () => {
		// Diffed word by word, the unlink marked only `[` and `](url)`, so the
		// link survived the accept and its destination stayed in the section.
		const key = sectionKey(STORED, "Next steps");
		const proposed = spliceSectionBody(
			STORED,
			key,
			"A short call and a plan.\n\n![Team photo](https://example.com/team.png)",
		);
		if (proposed === null) {
			throw new Error("no section to splice");
		}
		const editor = new Editor({
			extensions: advancedExtensions,
			content: fromMarkdown(diffPartialText(STORED, proposed, true)),
		});
		const saved = getEditorMarkdownForSave(editor);
		editor.destroy();
		if (saved === null) {
			throw new Error("serialization failed");
		}

		expect(saved).toContain("A short call and a plan.");
		expect(saved).not.toContain("https://example.com/call");
		expect(saved).toContain("![Team photo](https://example.com/team.png)");
		expect(sectionFingerprint(saved, key)).toBeDefined();
		expect(sectionFingerprint(saved, key)).toBe(
			sectionFingerprint(proposed, key),
		);
	});
});

describe("editor-markdown-save: a deleted bullet that holds a link (Fizzy #2946)", () => {
	// A link is the outer mark of deleted linked text, so the deleted item
	// is `<li><p><a …><del …>…</del></a></p></li>`. Unless the save drops the
	// whole item, it keeps an empty bullet, and the accepted section no
	// longer matches the candidate's signed fingerprint.
	function acceptInSection(
		body: string,
		candidate: string,
	): { key: string; proposed: string; saved: string } {
		const stored = `## Scope\n\n${body}\n\n## Next\n\nMore.`;
		const key = buildSectionMap(stored).sections.find(
			(section) => section.headingText === "Scope",
		)?.key;
		const proposed = key && spliceSectionBody(stored, key, candidate);
		if (!key || !proposed) {
			throw new Error("no section to splice");
		}
		const editor = new Editor({
			extensions: advancedExtensions,
			content: fromMarkdown(diffPartialText(stored, proposed, true)),
		});
		const saved = getEditorMarkdownForSave(editor);
		editor.destroy();
		if (saved === null) {
			throw new Error("serialization failed");
		}
		return { key, proposed, saved };
	}

	it.each([
		{
			name: "a plain bullet (control)",
			body: "- First\n- Plain second\n- Third",
			candidate: "- First\n- Third",
			items: ["First", "Third"],
		},
		{
			name: "a bullet that is only a link",
			body: "- First\n- [Report link](https://example.com/report)\n- Third",
			candidate: "- First\n- Third",
			items: ["First", "Third"],
		},
		{
			name: "a bullet of text and a link",
			body: "- First\n- See [the report](https://example.com/report)\n- Third",
			candidate: "- First\n- Third",
			items: ["First", "Third"],
		},
		{
			name: "the first item of a numbered list, a link",
			body: "1. [Open the inbox](https://example.com/inbox)\n2. Choose a mode\n3. Accept",
			candidate: "2. Choose a mode\n3. Accept",
			items: ["Choose a mode", "Accept"],
		},
		{
			name: "only the link of a bullet that keeps its other text",
			body: "- First\n- See [the report](https://example.com/report) now\n- Third",
			candidate: "- First\n- See now\n- Third",
			items: ["First", "See now", "Third"],
		},
	])(
		"$name: saves no empty item, and the candidate's fingerprint",
		({ body, candidate, items }) => {
			const { key, proposed, saved } = acceptInSection(body, candidate);

			const savedItems = saved
				.split("\n")
				.map((line) => line.match(/^(?:-|\d+\.)\s+(.*)$/)?.[1])
				.filter((item) => item !== undefined);
			expect(savedItems).toEqual(items);
			expect(saved).not.toContain("https://example.com/report");
			expect(saved).not.toContain("https://example.com/inbox");
			expect(sectionFingerprint(saved, key)).toBe(
				sectionFingerprint(proposed, key),
			);
		},
	);
});

describe("editor-markdown-save: an accepted change to a link or image (Fizzy #2946)", () => {
	// A word diff split a link into words, so its markers landed inside the
	// `(…)`: markdown-it percent-encoded them into the href (a host into
	// punycode), and an unlink marked only `[` and `](url)`, so the link
	// survived the accept. Each construct is now diffed as one word.
	const DIFFS = [
		{ name: "diffPartialText", diff: diffPartialText },
		{
			name: "diffKeepingVisualSlotsWhole",
			diff: diffKeepingVisualSlotsWhole,
		},
	];

	/** What the editor saves for `markdown` loaded with no diff. */
	function saveDirect(
		markdown: string,
		options?: FromMarkdownOptions,
	): string {
		const editor = new Editor({
			extensions: advancedExtensions,
			content: fromMarkdown(markdown, options),
		});
		const saved = getEditorMarkdownForSave(editor);
		editor.destroy();
		if (saved === null) {
			throw new Error("serialization failed");
		}
		return saved;
	}

	/**
	 * The accept path: the complete diff in the editor, then the save. Also
	 * returns the review editor's HTML, where a marker inside a construct
	 * shows up encoded in an `href` or `src`.
	 */
	function acceptAll(
		diff: (
			oldText: string,
			newText: string,
			isComplete?: boolean,
		) => string,
		before: string,
		after: string,
		options?: FromMarkdownOptions,
	): { review: string; saved: string } {
		const editor = new Editor({
			extensions: advancedExtensions,
			content: fromMarkdown(diff(before, after, true), options),
		});
		const review = editor.getHTML();
		const saved = getEditorMarkdownForSave(editor);
		editor.destroy();
		if (saved === null) {
			throw new Error("serialization failed");
		}
		return { review, saved };
	}

	const inProse = (link: string) =>
		`Intro.\n\nSee ${link} for details.\n\nOutro.`;
	const asBlock = (block: string) => `Intro.\n\n${block}\n\nOutro.`;
	const DIFF_DAMAGE = /%E2%80%8B|%C2%A0|_START|_END|xn--|<del|<ins/i;
	const ENCODED_MARKER = /%E2%80%8B|xn--/i;

	const SCENARIOS = [
		{
			name: "a URL-only change",
			before: inProse("[the docs](https://example.com/old)"),
			after: inProse("[the docs](https://example.com/new)"),
			saves: "See [the docs](https://example.com/new) for details.",
			drops: "https://example.com/old",
		},
		{
			name: "a host change",
			before: inProse("[the guide](https://old.example.com/guide)"),
			after: inProse("[the guide](https://new.example.com/guide)"),
			saves: "See [the guide](https://new.example.com/guide) for details.",
			drops: "old.example.com",
		},
		{
			name: "a link removed, its text kept",
			before: inProse("[the docs](https://example.com/a)"),
			after: inProse("the docs"),
			saves: "See the docs for details.",
			drops: "https://example.com/a",
		},
		{
			name: "a link added to plain text",
			before: inProse("the docs"),
			after: inProse("[the docs](https://example.com/a)"),
			saves: "See [the docs](https://example.com/a) for details.",
			drops: "See the docs for",
		},
		{
			name: "a block image src",
			before: asBlock("![Chart](https://example.com/a.png)"),
			after: asBlock("![Chart](https://example.com/b.png)"),
			saves: "![Chart](https://example.com/b.png)",
			drops: "https://example.com/a.png",
		},
		{
			name: "an inline image src",
			before: inProse("![Chart](https://example.com/a.png)"),
			after: inProse("![Chart](https://example.com/b.png)"),
			saves: "![Chart](https://example.com/b.png)",
			drops: "https://example.com/a.png",
		},
		{
			name: "the link around a Markdown image",
			before: asBlock(
				"[![Logo](https://example.com/logo.png)](https://example.com/a)",
			),
			after: asBlock(
				"[![Logo](https://example.com/logo.png)](https://example.com/b)",
			),
			saves: "[![Logo](https://example.com/logo.png)](https://example.com/b)",
			drops: "https://example.com/a)",
		},
		{
			name: "the link around an uploaded image tag",
			before: asBlock(
				'[<img src="https://example.com/one.png" alt="" width="320" />](https://example.com/a)',
			),
			after: asBlock(
				'[<img src="https://example.com/one.png" alt="" width="320" />](https://example.com/b)',
			),
			saves: '[<img src="https://example.com/one.png" alt="" width="320" />](https://example.com/b)',
			drops: "https://example.com/a)",
		},
		{
			name: "an uploaded image tag's src",
			before: asBlock(
				'<img src="https://example.com/one.png" alt="" width="320" />',
			),
			after: asBlock(
				'<img src="https://example.com/two.png" alt="" width="320" />',
			),
			saves: '<img src="https://example.com/two.png" alt="" width="320" />',
			drops: "https://example.com/one.png",
		},
		{
			name: "an autolink",
			before: inProse("<https://example.com/a>"),
			after: inProse("<https://example.com/b>"),
			saves: "https://example.com/b",
			drops: "https://example.com/a",
		},
		{
			name: "a link title",
			before: inProse('[the docs](https://example.com/a "Old")'),
			after: inProse('[the docs](https://example.com/a "New")'),
			saves: 'See [the docs](https://example.com/a "New") for details.',
			drops: '"Old"',
		},
		{
			name: "a destination with an escaped parenthesis",
			before: inProse("[the spec](https://example.com/spec_\\(v1\\))"),
			after: inProse("[the spec](https://example.com/spec_\\(v2\\))"),
			saves: "See [the spec](https://example.com/spec_\\(v2\\)) for details.",
			drops: "v1",
		},
		{
			name: "a destination with nested parentheses",
			before: inProse("[the term](https://example.com/wiki/Term_(v1))"),
			after: inProse("[the term](https://example.com/wiki/Term_(v2))"),
			saves: "Term_\\(v2\\)",
			drops: "v1",
		},
		{
			name: "a destination in angle brackets",
			before: inProse("[the docs](<https://example.com/a>)"),
			after: inProse("[the docs](<https://example.com/b>)"),
			saves: "See [the docs](https://example.com/b) for details.",
			drops: "https://example.com/a",
		},
		{
			name: "link text with escaped brackets",
			before: inProse("[Report \\[S1\\]](https://example.com/r1)"),
			after: inProse("[Report \\[S1\\]](https://example.com/r2)"),
			saves: "See [Report \\[S1\\]](https://example.com/r2) for details.",
			drops: "https://example.com/r1",
		},
		{
			name: "link text with a hard break",
			before: inProse(
				"[first line  \nsecond line](https://example.com/a)",
			),
			after: inProse(
				"[first line  \nsecond line](https://example.com/b)",
			),
			saves: "second line](https://example.com/b)",
			drops: "https://example.com/a",
		},
		{
			name: "a link with a hard break removed, its text kept",
			before: inProse(
				"[first line  \nsecond line](https://example.com/a)",
			),
			after: inProse("first line  \nsecond line"),
			saves: "second line for details.",
			drops: "https://example.com/a",
		},
		{
			name: "a link in a table cell",
			before: asBlock(
				"| Name | Link |\n| --- | --- |\n| Docs | [the docs](https://example.com/old) |",
			),
			after: asBlock(
				"| Name | Link |\n| --- | --- |\n| Docs | [the docs](https://example.com/new) |",
			),
			saves: "| Docs | [the docs](https://example.com/new) |",
			drops: "https://example.com/old",
		},
	];

	describe.each(DIFFS)("through $name", ({ diff }) => {
		it.each(SCENARIOS)(
			"$name: accept saves the new document",
			({ before, after, saves, drops }) => {
				const { review, saved } = acceptAll(diff, before, after);

				expect(review).not.toMatch(ENCODED_MARKER);
				expect(saved).toBe(saveDirect(after));
				expect(saved).toContain(saves);
				expect(saved).not.toContain(drops);
				expect(saved).not.toMatch(DIFF_DAMAGE);
			},
		);
	});

	// Every reject-all handler renders the stored baseline again, so these
	// pass with or without the diff: they pin that the old value survives.
	it.each([
		{
			name: "a link added to plain text",
			before: inProse("the docs"),
			keeps: "See the docs for details.",
		},
		{
			name: "a block image src",
			before: asBlock("![Chart](https://example.com/a.png)"),
			keeps: "![Chart](https://example.com/a.png)",
		},
		{
			name: "an inline image src",
			before: inProse("![Chart](https://example.com/a.png)"),
			keeps: "![Chart](https://example.com/a.png)",
		},
	])("$name: reject-all keeps the old value", ({ before, keeps }) => {
		expect(saveDirect(before)).toContain(keeps);
	});

	it("keeps a visual slot when a link beside it changes", () => {
		const slot = serializeVisualSlot({
			id: "slot-a",
			kind: "timeline",
			hint: "Phases",
		});
		const before = `${inProse("[the docs](https://example.com/old)")}\n\n${slot}`;
		const after = `${inProse("[the docs](https://example.com/new)")}\n\n${slot}`;

		const { review, saved } = acceptAll(
			diffKeepingVisualSlotsWhole,
			before,
			after,
		);

		expect(review).not.toMatch(ENCODED_MARKER);
		expect(saved).toBe(saveDirect(after));
		expect(saved).toContain(
			"See [the docs](https://example.com/new) for details.",
		);
		expect(saved.split("\n")).toContain(slot);
		expect(saved).not.toMatch(DIFF_DAMAGE);
	});

	it("behaves the same rendered with StoryWorkspace's options", () => {
		// StoryWorkspace's module-scoped `USER_CONTENT_MD_OPTIONS`.
		const options = { repairLegacyBullets: false } as const;
		const before = inProse("[the guide](https://old.example.com/guide)");
		const after = inProse("[the guide](https://new.example.com/guide)");

		const { review, saved } = acceptAll(
			diffPartialText,
			before,
			after,
			options,
		);

		expect(review).not.toMatch(ENCODED_MARKER);
		expect(saved).toBe(saveDirect(after, options));
		expect(saved).toContain(
			"See [the guide](https://new.example.com/guide) for details.",
		);
		expect(saved).not.toMatch(DIFF_DAMAGE);
	});
});

describe("editor-markdown-save: emphasis is not re-escaped", () => {
	it("keeps bold as ** and does not emit \\* in saved markdown", () => {
		const markdown = "A paragraph with **bold label:** and more text.";
		const editor = new Editor({
			extensions: advancedExtensions,
			content: fromMarkdown(markdown),
		});
		const saved = getEditorMarkdownForSave(editor);
		editor.destroy();

		expect(saved).toContain("**bold label:**");
		expect(saved).not.toMatch(/\\\*/);
	});
});

describe("editor-markdown-save: stat tiles fences (Fizzy #2946)", () => {
	// A Proposal's stat tiles are a ```stat-tiles fence. The document editor
	// draws it as its own node, whose HTML is the same <pre><code
	// class="language-stat-tiles"> a code block's is, so the fencedCodeBlocks
	// rule must keep the hyphenated language and the body as they were.
	const STAT_TILES = [
		"```stat-tiles",
		"%% fabric-visual: a1b2c3d4e5f6",
		"Faster onboarding: 40%",
		"Pilot sites: 3",
		"Annual savings: $1.2M",
		"```",
	].join("\n");
	const DOCUMENT = `## Results\n\nThe pilot went well.\n\n${STAT_TILES}\n\nNext steps follow.`;

	function documentEditor(markdown: string): Editor {
		return new Editor({
			extensions: createAdvancedExtensions({
				projectId: null,
				documentId: null,
				statTiles: true,
			}),
			content: fromMarkdown(markdown),
		});
	}

	it("serializes the node's HTML back to the fence with its hyphenated language", () => {
		const saved = createTurndownService().turndown(
			'<pre data-language="stat-tiles"><code class="language-stat-tiles">%% fabric-visual: a1b2c3d4e5f6\nFaster onboarding: 40%\nPilot sites: 3\nAnnual savings: $1.2M\n</code></pre>',
		);

		expect(saved).toBe(STAT_TILES);
	});

	it("round-trips the fence byte for byte through the document editor", () => {
		const editor = documentEditor(DOCUMENT);
		const types: string[] = [];
		editor.state.doc.forEach((node) => {
			types.push(node.type.name);
		});
		const saved = getEditorMarkdownForSave(editor);
		editor.destroy();

		expect(types).toContain("statTilesBlock");
		expect(saved).toBe(DOCUMENT);
	});

	it("round-trips the fence byte for byte through an editor that keeps it as code", () => {
		const editor = new Editor({
			extensions: advancedExtensions,
			content: fromMarkdown(DOCUMENT),
		});
		const saved = getEditorMarkdownForSave(editor);
		editor.destroy();

		expect(saved).toBe(DOCUMENT);
	});

	it("trims trailing blank lines inside the fence, as it does for every fence", () => {
		const editor = documentEditor("```stat-tiles\nPilot sites: 3\n\n\n```");
		const saved = getEditorMarkdownForSave(editor);
		editor.destroy();

		expect(saved).toBe("```stat-tiles\nPilot sites: 3\n```");
	});
});

describe("editor-markdown-save: generated diagram marker (Fizzy #2946)", () => {
	// A diagram the visuals step writes opens its fence with a
	// `%% fabric-visual: <id>` line; the spec stored for it is found again by
	// that id and the body's source hash, so both must survive a load and
	// save through the editor.
	const VISUAL_ID = "k3v9q2m7x1a8c4d6";
	const SOURCE = fillVisualColors(
		visualSpecToMermaid({
			kind: "timeline",
			items: [
				{ date: "Q1 2026", label: "Discovery" },
				{ date: "Q2 2026", label: "Launch", description: "Go live" },
			],
		}),
		deriveGlossyPalette({
			overrides: { primary: "#334155", accents: ["#475569"] },
		}),
	);
	const FENCE = toMermaidFence(SOURCE, VISUAL_ID);
	const DOCUMENT = `## Delivery\n\nWe start in Q1 2026 and launch in Q2 2026.\n\n${FENCE}\n\nNext steps follow.`;

	const bodyOf = (markdown: string) =>
		/```mermaid\n([\s\S]*?)\n```/.exec(markdown)?.[1] ?? "";

	function roundTrip(
		markdown: string,
		statTiles: boolean,
	): {
		types: string[];
		saved: string;
	} {
		const editor = new Editor({
			extensions: createAdvancedExtensions({
				projectId: null,
				documentId: null,
				statTiles,
			}),
			content: fromMarkdown(markdown),
		});
		const types: string[] = [];
		editor.state.doc.forEach((node) => {
			types.push(node.type.name);
		});
		const saved = getEditorMarkdownForSave(editor);
		editor.destroy();
		return { types, saved };
	}

	it("keeps the marker as the fence's first line, and the source hash, through load and save", () => {
		const { types, saved } = roundTrip(DOCUMENT, true);

		expect(types).toContain("mermaidBlock");
		const body = bodyOf(saved);
		expect(body.split("\n")[0]).toBe(`%% fabric-visual: ${VISUAL_ID}`);
		expect(visualSourceHash(body)).toBe(visualSourceHash(bodyOf(FENCE)));
		expect(body).toBe(bodyOf(FENCE));
	});

	it("keeps an indented body's indentation, so its hash holds too", () => {
		const indented = [
			"```mermaid",
			`%% fabric-visual: ${VISUAL_ID}`,
			"flowchart LR",
			'    a["Discovery"] --> b["Launch"]',
			"    style a fill:#e7e8eb",
			"```",
		].join("\n");
		const { saved } = roundTrip(`## Delivery\n\n${indented}`, true);

		expect(bodyOf(saved)).toBe(bodyOf(indented));
		expect(visualSourceHash(bodyOf(saved))).toBe(
			visualSourceHash(bodyOf(indented)),
		);
	});

	it("keeps a label's <br/> line break, and so the fence and its hash, byte-identical", () => {
		const withBreaks = [
			"```mermaid",
			`%% fabric-visual: ${VISUAL_ID}`,
			"flowchart LR",
			'  t0["Q1 2026<br/>Discovery"]',
			'  t1["Q2 2026<br/>Launch<br/>Go live"]',
			"  t0 --> t1",
			"  class t0 surface",
			"  class t1 surface",
			"```",
		].join("\n");
		const document = `## Delivery\n\nWe start in Q1 2026.\n\n${withBreaks}\n\nNext steps follow.`;

		const { types, saved } = roundTrip(document, true);

		expect(types).toContain("mermaidBlock");
		expect(saved).toBe(document);
		expect(bodyOf(saved)).toBe(bodyOf(withBreaks));
		expect(visualSourceHash(bodyOf(saved))).toBe(
			visualSourceHash(bodyOf(withBreaks)),
		);
		// Twice through, as a reopened document is.
		expect(roundTrip(saved, true).saved).toBe(document);
	});

	it("classifies the saved fence as the generated visual it was", () => {
		const row = {
			visualId: VISUAL_ID,
			sourceHash: visualSourceHash(bodyOf(FENCE)),
			kind: "timeline",
			origin: "STEP" as const,
		};
		const { saved } = roundTrip(roundTrip(DOCUMENT, true).saved, false);

		expect(classifyVisualFences(saved, [row])).toEqual([
			expect.objectContaining({
				state: "generated",
				visualId: VISUAL_ID,
			}),
		]);
	});
});

function bulletCount(markdown: string): number {
	return (markdown.match(/^\s*-\s+/gm) || []).length;
}

function orderedCount(markdown: string): number {
	return (markdown.match(/^\s*\d+\.\s+/gm) || []).length;
}

describe("editor-markdown-save: list fidelity (#1987)", () => {
	// The reported symptom. `mergeOrphanBulletContinuations` merges a bullet into
	// its predecessor when the previous bullet lacks terminal punctuation and the
	// next starts lowercase (diff-utils.ts:1000-1110). That shape is extremely
	// common in hand-written lists, and Effect 4 laundered the rewrite into the
	// save baseline, so the user's bullets were permanently merged.
	const HAND_WRITTEN = `## Notes

- must handle retries
- and log failures
- then alert the on-call engineer`;

	it("preserves every bullet through a load → save round trip", () => {
		const editor = new Editor({
			extensions: advancedExtensions,
			content: fromMarkdown(HAND_WRITTEN, {
				repairLegacyBullets: false,
			}),
		});
		const saved = getEditorMarkdownForSave(editor);
		editor.destroy();

		expect(saved).not.toBeNull();
		expect(bulletCount(saved as string)).toBe(3);
		expect(saved).toContain("and log failures");
		expect(saved).toContain("then alert the on-call engineer");
	});

	// Answers the card's open Supporting Question and covers AC4.
	it("preserves numbered lists through a load → save round trip", () => {
		const numbered = `1. must handle retries
2. and log failures
3. then alert the on-call engineer`;

		const editor = new Editor({
			extensions: advancedExtensions,
			content: fromMarkdown(numbered, { repairLegacyBullets: false }),
		});
		const saved = getEditorMarkdownForSave(editor);
		editor.destroy();

		expect(saved).not.toBeNull();
		expect(orderedCount(saved as string)).toBe(3);
	});

	// mergeBulletFragments (editor-save-utils.ts:146) merged any bullet whose
	// body began with ';', ',' or ':' into the previous line. Removed from the
	// write path in Task 4 — this locks that in.
	it("preserves a bullet that legitimately starts with punctuation", () => {
		const punctuated = `- see the appendix
- : reference table
- ; and the glossary`;

		const editor = new Editor({
			extensions: advancedExtensions,
			content: fromMarkdown(punctuated, { repairLegacyBullets: false }),
		});
		const saved = getEditorMarkdownForSave(editor);
		editor.destroy();

		expect(saved).not.toBeNull();
		expect(bulletCount(saved as string)).toBe(3);
	});

	// The repair must stay ON by default — AI-emitted markdown genuinely wraps
	// long bullets to column 0 (issue #737) and relies on it.
	it("still repairs orphan continuations when not opted out", () => {
		const aiWrapped = `- a bullet whose text wraps onto
the following line at column zero`;

		const html = fromMarkdown(aiWrapped);

		// CommonMark lazy continuation already folds a column-0 line into the
		// preceding list item regardless of the repair flag, so a plain
		// substring/`<li>`-count check passes even with the repair disabled.
		// The repair's only observable effect is *how* the two source lines
		// join: it collapses the line break into a single space, whereas lazy
		// continuation alone leaves the literal newline in place.
		expect(html).toContain("wraps onto the following line at column zero");
		expect((html.match(/<li>/g) || []).length).toBe(1);
	});

	// CRITICAL (#1987): the raw→rich toggle in StoryWorkspace runs
	// `repairMarkdownDocument` then `fromMarkdown(repaired, USER_CONTENT_MD_OPTIONS)`
	// before handing the result to the editor. `repairMarkdownDocument` alone
	// leaves these bullets alone, but without the opt-out on the `fromMarkdown`
	// call, `mergeOrphanBulletContinuations` still collapses them — and that
	// setContent isn't guarded by `isSyncingFromPropRef`, so the collapse
	// autosaves 10s later with no further user action.
	//
	// `StoryWorkspace.tsx` (where `USER_CONTENT_MD_OPTIONS` and the real
	// toggle handler live) cannot be imported into vitest — it side-effect
	// imports CopilotKit's stylesheet plus a transitive katex `.css` pulled
	// in by a markdown-render dependency, which fails to load under
	// jsdom/vite ("Unknown file extension \".css\"", confirmed empirically).
	// Existing component tests for this surface only ever mock
	// `StoryWorkspace` out entirely (see `StoryWorkspacePage.*.test.tsx`),
	// so this can't drive the component's actual call site either. To still
	// catch a reverted opt-out rather than re-testing `fromMarkdown`'s option
	// in the abstract, this proves the opt-out is load-bearing for *this*
	// fixture: a negative control shows the same `repaired` text, run
	// without the opt-out (the shape a reverted call site would produce),
	// collapses below 3 bullets — so the main assertion below isn't
	// vacuously true regardless of what the option does.
	it("preserves every bullet through the raw→rich toggle's repair → fromMarkdown → editor → save chain", () => {
		const repaired = repairMarkdownDocument(HAND_WRITTEN);

		const unpatchedEditor = new Editor({
			extensions: advancedExtensions,
			content: fromMarkdown(repaired),
		});
		const unpatchedSaved = getEditorMarkdownForSave(unpatchedEditor);
		unpatchedEditor.destroy();
		expect(bulletCount(unpatchedSaved as string)).toBeLessThan(3);

		const editor = new Editor({
			extensions: advancedExtensions,
			content: fromMarkdown(repaired, { repairLegacyBullets: false }),
		});
		const saved = getEditorMarkdownForSave(editor);
		editor.destroy();

		expect(saved).not.toBeNull();
		expect(bulletCount(saved as string)).toBe(3);
		expect(saved).toContain("and log failures");
		expect(saved).toContain("then alert the on-call engineer");
	});

	// CRITICAL (#1987): both `handleReject`/`handleAccept` in
	// `StoryWorkspace.tsx` (using module-scoped `USER_CONTENT_MD_OPTIONS`)
	// and `useUpdateWithContext.ts`'s `reject()`/`confirm()` (using the
	// `fromMarkdown` prop `StoryWorkspace` injects — the prop's type used to
	// be `(markdown: string) => string`, no options parameter, so the hook
	// silently got the repair ON regardless of what StoryWorkspace opted out
	// of elsewhere) load serializer output of *user* content
	// (`baselineRef.current` / `finalContent`) back through `fromMarkdown`
	// to restore/settle the editor. Without the `{ repairLegacyBullets:
	// false }` opt-out on that call, the repair collapses a hand-written
	// list — and the merged text then gets laundered into the save baseline
	// by Effect 4, so the next save persists it. Both call sites exercise
	// the identical chain shape, so one test covers both (previously two
	// near-duplicate tests here, one per call site).
	//
	// Neither `StoryWorkspace.tsx` nor `useUpdateWithContext.ts` can be
	// driven directly here (see the raw→rich test above for why), so this
	// drives the same chain shape instead: editor -> save (produces a
	// realistic baseline) -> fromMarkdown with the opt-out -> editor ->
	// save. A negative control (baseline round-tripped WITHOUT the
	// opt-out — the shape a reverted call site would produce) proves the
	// opt-out is load-bearing for this fixture, so the main assertion isn't
	// vacuously true.
	it("preserves every bullet through the reject chain (editor -> save -> fromMarkdown(opt-out) -> editor -> save)", () => {
		const firstEditor = new Editor({
			extensions: advancedExtensions,
			content: fromMarkdown(HAND_WRITTEN, { repairLegacyBullets: false }),
		});
		const baseline = getEditorMarkdownForSave(firstEditor);
		firstEditor.destroy();

		expect(baseline).not.toBeNull();

		const unpatchedEditor = new Editor({
			extensions: advancedExtensions,
			content: fromMarkdown(baseline as string),
		});
		const unpatchedSaved = getEditorMarkdownForSave(unpatchedEditor);
		unpatchedEditor.destroy();
		expect(bulletCount(unpatchedSaved as string)).toBeLessThan(3);

		const rejectedEditor = new Editor({
			extensions: advancedExtensions,
			// Mirrors the `USER_CONTENT_MD_OPTIONS` opt-out at the
			// `handleReject` call site in StoryWorkspace.tsx, and the
			// equivalent literal at `useUpdateWithContext.ts`'s `reject()`.
			content: fromMarkdown(baseline as string, {
				repairLegacyBullets: false,
			}),
		});
		const saved = getEditorMarkdownForSave(rejectedEditor);
		rejectedEditor.destroy();

		expect(saved).not.toBeNull();
		expect(bulletCount(saved as string)).toBe(3);
	});
});

describe("editor-markdown-save: failure signalling (#1987)", () => {
	it("returns null when serialization throws, so callers can refuse to save", () => {
		// Previously this returned "", and StoryWorkspace's handleSave wrote
		// `description: null` — a single Turndown throw silently wiped the whole
		// feature description.
		const editor = new Editor({
			extensions: advancedExtensions,
			content: fromMarkdown("# Real content\n\n- one\n- two"),
		});
		// Force the serializer to throw at the getHTML boundary.
		editor.getHTML = () => {
			throw new Error("boom");
		};

		expect(getEditorMarkdownForSave(editor)).toBeNull();

		editor.destroy();
	});

	it("still returns an empty string for a genuinely empty document", () => {
		// "" and null must stay distinguishable: "" is a legitimate save.
		const editor = new Editor({
			extensions: advancedExtensions,
			content: "",
		});

		expect(getEditorMarkdownForSave(editor)).toBe("");

		editor.destroy();
	});

	it("returns null for a null editor", () => {
		expect(getEditorMarkdownForSave(null)).toBeNull();
	});
});

describe("editor-markdown-save: onUpdate ref-indirection (#1987)", () => {
	// StoryWorkspace's autosave never fired: `useEditor(..., [])` (an empty
	// dep array) means TipTap's `Editor` — including the `onUpdate` callback
	// — is constructed once, at first render, and `Editor#setOptions` does
	// NOT re-bind `onUpdate`. So the `onUpdate` that actually runs on every
	// keystroke is forever render-1's closure, whose captured
	// `hasUnsavedChanges`/`triggerAutoSave` are stale. This locks in that
	// mechanism directly against `@tiptap/core`'s `Editor`, independent of
	// React state — `StoryWorkspace.tsx` cannot be imported into vitest (it
	// side-effect imports CopilotKit's stylesheet plus a transitive katex
	// `.css` from a markdown-render dependency; importing it fails with
	// "Unknown file extension \".css\"" under jsdom/vite, confirmed
	// empirically), and existing component tests for this surface only ever
	// mock `StoryWorkspace` out rather than render it (see
	// `StoryWorkspacePage.*.test.tsx`). So the fix itself — the wiring from
	// `onUpdate`'s setTimeout through `triggerAutoSaveRef.current?.()` to
	// the real `triggerAutoSave` closure — is exercised here at the
	// `Editor` level; it is NOT covered by rendering the actual
	// `StoryWorkspace` component. Full end-to-end coverage of the wiring is
	// staging E2E only.
	it("setOptions({ onUpdate }) does not re-register onUpdate — a doc change after it still fires the constructor's closure", () => {
		const calls: string[] = [];
		const editor = new Editor({
			extensions: advancedExtensions,
			content: fromMarkdown("first"),
			onUpdate: () => calls.push("constructor"),
		});

		editor.setOptions({ onUpdate: () => calls.push("setOptions") });
		editor.commands.setContent(fromMarkdown("second"));

		expect(calls).toEqual(["constructor"]);
		editor.destroy();
	});

	// The fix (mirrors `triggerAutoSaveRef` in StoryWorkspace.tsx /
	// DocumentEditor.tsx): the sealed `onUpdate` never calls the save
	// trigger directly — it calls through a ref, and a later render's
	// direct-assignment (`triggerAutoSaveRef.current = triggerAutoSave;`)
	// keeps that ref pointed at the freshest closure. So even though
	// `onUpdate` itself is sealed, what it invokes is not.
	it("indirecting onUpdate through a ref picks up the latest callback despite the seal", () => {
		const calls: string[] = [];
		const latestRef: { current: (() => void) | null } = { current: null };
		latestRef.current = () => calls.push("render-1");

		const editor = new Editor({
			extensions: advancedExtensions,
			content: fromMarkdown("first"),
			onUpdate: () => latestRef.current?.(),
		});

		// A later render reassigning the ref — the render-body-assignment
		// pattern this fix uses.
		latestRef.current = () => calls.push("latest-render");

		editor.commands.setContent(fromMarkdown("second"));

		expect(calls).toEqual(["latest-render"]);
		editor.destroy();
	});

	// End-to-end shape of the actual fix: a doc change schedules the same
	// 10s `setTimeout` StoryWorkspace's `onUpdate` does, whose body calls
	// through the ref rather than a captured variable. Advancing past the
	// debounce invokes whatever the ref points to at fire time — proving a
	// doc change really does result in a (simulated) save call once the
	// debounce elapses, not just that the ref reassignment itself works.
	it("a doc change followed by the 10s debounce elapsing invokes the latest ref target — the autosave fires", () => {
		vi.useFakeTimers();
		try {
			const saveCalls: string[] = [];
			const triggerAutoSaveRef: { current: (() => void) | null } = {
				current: null,
			};
			// Render 1's stale closure — must NOT be the one that fires.
			triggerAutoSaveRef.current = () => saveCalls.push("stale-render-1");

			const editor = new Editor({
				extensions: advancedExtensions,
				content: fromMarkdown("first"),
				onUpdate: () => {
					setTimeout(() => {
						triggerAutoSaveRef.current?.();
					}, 10000);
				},
			});

			// A later render's direct-assignment, closing over the current
			// `hasUnsavedChanges` — the fix under test.
			triggerAutoSaveRef.current = () => saveCalls.push("save");

			editor.commands.setContent(fromMarkdown("second"));
			vi.advanceTimersByTime(10000);

			expect(saveCalls).toEqual(["save"]);
			editor.destroy();
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("editor-markdown-save: the review shows the destination the save stores (Fizzy #2946)", () => {
	// Diff markers percent-encoded into a destination are resolved when the
	// document is saved. Unresolved in the review, the link a person approves
	// is not the one stored: the deleted run can hide a different host in the
	// userinfo, or split a scheme the link rules would refuse.
	const ENC_DEL_START = "%E2%80%8B%E2%80%8BDEL_START%E2%80%8B%C2%A0";
	const ENC_DEL_END = "%C2%A0%E2%80%8BDEL_END%E2%80%8B%E2%80%8B";

	function review(stored: string, proposed: string) {
		const editor = new Editor({
			extensions: advancedExtensions,
			content: fromMarkdown(diffPartialText(stored, proposed, true)),
		});
		const hrefs = [...editor.view.dom.querySelectorAll("a[href]")].map(
			(link) => link.getAttribute("href") ?? "",
		);
		const saved = getEditorMarkdownForSave(editor);
		editor.destroy();
		if (saved === null) {
			throw new Error("serialization failed");
		}
		return { hrefs, saved };
	}

	it("reviews the host the save keeps when a deleted run hides it in the userinfo", () => {
		const { hrefs, saved } = review(
			"Pay the deposit.",
			`[Pay the deposit](https://evil.example${ENC_DEL_START}@trusted.example.com/x${ENC_DEL_END}/pay).`,
		);

		expect(hrefs).toEqual(["https://evil.example/pay"]);
		expect(saved).toContain("(https://evil.example/pay)");
	});

	it("never saves a scheme the review did not show", () => {
		const { hrefs, saved } = review(
			"Open the guide.",
			`[Open the guide](java${ENC_DEL_START}x${ENC_DEL_END}script:alert(1)).`,
		);

		// The review shows the refused link as text, and the save keeps it as
		// text: escaped, never a link.
		expect(hrefs.some((href) => href.includes("script"))).toBe(false);
		expect(saved).toBe("\\[Open the guide\\](javascript:alert(1)).");
	});
});

describe("editor-markdown-save: a destination with raw or partly encoded markers (Fizzy #2946)", () => {
	// A model can write the marker characters raw, or encode only some of
	// them. The link parser encodes the rest, and the save resolves the run,
	// so the review must resolve it in the same place.
	const ENC_DEL_START = "%E2%80%8B%E2%80%8BDEL_START%E2%80%8B%C2%A0";
	const ENC_DEL_END = "%C2%A0%E2%80%8BDEL_END%E2%80%8B%E2%80%8B";
	const NBSP = decodeURIComponent("%C2%A0");
	const spellings = {
		raw: [
			decodeURIComponent(ENC_DEL_START),
			decodeURIComponent(ENC_DEL_END),
		],
		"partly encoded": [
			ENC_DEL_START.replace("%C2%A0", NBSP),
			ENC_DEL_END.replace("%C2%A0", NBSP),
		],
	};

	function review(stored: string, proposed: string) {
		const editor = new Editor({
			extensions: advancedExtensions,
			content: fromMarkdown(diffPartialText(stored, proposed, true)),
		});
		const hrefs = [...editor.view.dom.querySelectorAll("a[href]")].map(
			(link) => link.getAttribute("href") ?? "",
		);
		const saved = getEditorMarkdownForSave(editor);
		editor.destroy();
		if (saved === null) {
			throw new Error("serialization failed");
		}
		return { hrefs, saved };
	}

	it.each(Object.entries(spellings))(
		"reviews the host the save keeps (%s)",
		(_spelling, [start, end]) => {
			const { hrefs, saved } = review(
				"Pay the deposit.",
				`[Pay the deposit](https://evil.example${start}@trusted.example.com/x${end}/pay).`,
			);

			expect(hrefs).toEqual(["https://evil.example/pay"]);
			expect(saved).toContain("(https://evil.example/pay)");
		},
	);

	it.each(Object.entries(spellings))(
		"never saves a scheme link the review did not show (%s)",
		(_spelling, [start, end]) => {
			const { hrefs, saved } = review(
				"Open the guide.",
				`[Open the guide](java${start}x${end}script:alert(1)).`,
			);

			expect(hrefs.some((href) => href.includes("script"))).toBe(false);
			expect(saved).not.toMatch(/(?<!\\)\]\(javascript:/);
		},
	);
});

describe("editor-markdown-save: link-shaped text across a block boundary (Fizzy #2946)", () => {
	// A list item interrupts the paragraph, so this is no link, and an edit
	// inside it is an ordinary word change.
	it("accepts an edit as the saved candidate", () => {
		const save = (markdown: string) => {
			const editor = new Editor({
				extensions: advancedExtensions,
				content: fromMarkdown(markdown),
			});
			const saved = getEditorMarkdownForSave(editor);
			editor.destroy();
			return saved;
		};
		const stored = "Note [draft\n- item](https://example.com/a)";
		const candidate = "Note [draft\n- item two](https://example.com/a)";

		expect(save(diffPartialText(stored, candidate, true))).toBe(
			save(candidate),
		);
	});
});

/** Load `markdown` into the document editor: its HTML, its hrefs and its save. */
function loadAndSave(markdown: string): {
	review: string;
	hrefs: string[];
	saved: string;
} {
	const editor = new Editor({
		extensions: advancedExtensions,
		content: fromMarkdown(markdown),
	});
	const review = editor.getHTML();
	const hrefs = [...editor.view.dom.querySelectorAll("a[href]")].map(
		(link) => link.getAttribute("href") ?? "",
	);
	const saved = getEditorMarkdownForSave(editor);
	editor.destroy();
	if (saved === null) {
		throw new Error("serialization failed");
	}
	return { review, hrefs, saved };
}

// A diff marker that reached an attribute or a destination: encoded,
// spelled out, or a host turned into punycode.
const MARKER_DAMAGE = /%E2%80%8B|%C2%A0|_START|_END|xn--/i;

describe("editor-markdown-save: a reference-style link (Fizzy #2946)", () => {
	// markdown-it consumes a link reference definition, and the save writes
	// every link inline. A changed definition was diffed as a line nobody
	// sees, its markers percent-encoded into the usage's href (a host into
	// punycode), so the review never showed the change.
	const OLD_URL = "https://old.example.com/path";
	const NEW_URL = "https://new.example.com/path";
	const withDefinition = (body: string, destination: string) =>
		`Intro.\n\n${body}\n\n[guide]: ${destination}`;
	const accept = (before: string, after: string) =>
		loadAndSave(diffPartialText(before, after, true));

	it.each([
		{
			name: "a full reference",
			body: "See [Docs][guide] for details.",
			saves: `See [Docs](${NEW_URL}) for details.`,
		},
		{
			name: "a collapsed reference",
			body: "See [guide][] for details.",
			saves: `See [guide](${NEW_URL}) for details.`,
		},
		{
			name: "a shortcut reference",
			body: "See [guide] for details.",
			saves: `See [guide](${NEW_URL}) for details.`,
		},
	])(
		"$name: reviews and saves the definition's new destination",
		({ body, saves }) => {
			const after = withDefinition(body, NEW_URL);
			const { hrefs, saved } = accept(
				withDefinition(body, OLD_URL),
				after,
			);

			expect(hrefs).toEqual([OLD_URL, NEW_URL]);
			expect(saved).toBe(loadAndSave(after).saved);
			expect(saved).toContain(saves);
			expect(saved).not.toContain(OLD_URL);
			expect(saved).not.toMatch(MARKER_DAMAGE);
		},
	);

	it("an image reference: reviews and saves the definition's new source", () => {
		const body = "See ![Logo][guide] for details.";
		const after = withDefinition(body, NEW_URL);
		const { review, saved } = accept(withDefinition(body, OLD_URL), after);

		expect(review).toContain(`src="${NEW_URL}"`);
		expect(review).not.toMatch(MARKER_DAMAGE);
		expect(saved).toBe(loadAndSave(after).saved);
		expect(saved).toContain(`![Logo](${NEW_URL})`);
		expect(saved).not.toContain(OLD_URL);
		expect(saved).not.toMatch(MARKER_DAMAGE);
	});

	it("keeps a definition's title", () => {
		const body = "See [Docs][guide] for details.";
		const after = withDefinition(body, `${NEW_URL} "The guide"`);
		const { hrefs, saved } = accept(
			withDefinition(body, `${OLD_URL} "The guide"`),
			after,
		);

		expect(hrefs).toEqual([OLD_URL, NEW_URL]);
		expect(saved).toBe(loadAndSave(after).saved);
		expect(saved).toContain(
			`See [Docs](${NEW_URL} "The guide") for details.`,
		);
	});

	// Every reject-all handler renders the stored baseline again.
	it("reject-all keeps the old link", () => {
		expect(
			loadAndSave(
				withDefinition("See [Docs][guide] for details.", OLD_URL),
			).saved,
		).toContain(`See [Docs](${OLD_URL}) for details.`);
	});

	it("leaves a definition inside a code fence alone", () => {
		const fence = "```\n[guide]: https://example.com/code\n```";
		const before = `See [Docs][guide].\n\n${fence}\n\n[guide]: ${OLD_URL}`;
		const after = `See [Docs][guide].\n\n${fence}\n\n[guide]: ${NEW_URL}`;
		const { hrefs, saved } = accept(before, after);

		expect(hrefs).toEqual([OLD_URL, NEW_URL]);
		expect(saved).toBe(loadAndSave(after).saved);
		expect(saved).toContain(`See [Docs](${NEW_URL}).`);
		expect(saved).toContain(fence);
	});

	it("leaves a usage inside inline code alone", () => {
		const body = "Write `[Docs][guide]` to cite [Docs][guide].";
		const after = withDefinition(body, NEW_URL);
		const { hrefs, saved } = accept(withDefinition(body, OLD_URL), after);

		expect(hrefs).toEqual([OLD_URL, NEW_URL]);
		expect(saved).toBe(loadAndSave(after).saved);
		expect(saved).toContain(
			`Write \`[Docs][guide]\` to cite [Docs](${NEW_URL}).`,
		);
	});

	it("leaves an undefined label as text", () => {
		const body = "Cited as [S1] in [Docs][guide].";
		const after = withDefinition(body, NEW_URL);
		const { hrefs, saved } = accept(withDefinition(body, OLD_URL), after);

		expect(hrefs).toEqual([OLD_URL, NEW_URL]);
		expect(saved).toBe(loadAndSave(after).saved);
		expect(saved).toContain("Cited as \\[S1\\] in");
	});

	it("matches a label regardless of case and inner whitespace", () => {
		const body = "See [Docs][The  GUIDE].";
		const after = `${body}\n\n[the guide]: ${NEW_URL}`;
		const { hrefs, saved } = accept(
			`${body}\n\n[the guide]: ${OLD_URL}`,
			after,
		);

		expect(hrefs).toEqual([OLD_URL, NEW_URL]);
		expect(saved).toBe(loadAndSave(after).saved);
		expect(saved).toContain(`See [Docs](${NEW_URL}).`);
	});

	it("diffs an unchanged reference document as no change", () => {
		const stored = withDefinition(
			"See [Docs][guide], the [guide] and [Guide][] for details.",
			OLD_URL,
		);
		const diff = diffPartialText(stored, stored, true);

		expect(diff).not.toMatch(/_START|_END/);
		expect(loadAndSave(diff).saved).toBe(loadAndSave(stored).saved);
	});

	it.each([
		{
			change: "a path",
			from: "https://example.com/papers/old",
			to: "https://example.com/papers/new",
		},
		{
			change: "a host",
			from: "https://old.example.com/papers",
			to: "https://new.example.com/papers",
		},
	])(
		"keeps the definitions of a changed label with a usage it cannot rewrite ($change)",
		({ from, to }) => {
			// `[1]:` in a sentence is a usage markdown-it links, but it is left
			// as written. The definitions stay, so it still has one to resolve
			// to: the new one, never a definition with markers inside it.
			const define = (destination: string) =>
				`Intro.\n\nAs the paper [1]: says, the results hold. See [1] again.\n\n[1]: ${destination}`;
			const after = define(to);
			const diff = diffPartialText(define(from), after, true);
			const { hrefs, saved } = loadAndSave(diff);

			expect(diff).toContain(`\n[1]: ${to}`);
			expect(hrefs).toEqual([to, from, to]);
			expect(saved).toBe(loadAndSave(after).saved);
			expect(saved).toContain(`As the paper [1](${to}): says`);
			expect(saved).toContain(`See [1](${to}) again.`);
			expect(saved).not.toContain(from);
			expect(saved).not.toMatch(MARKER_DAMAGE);
		},
	);

	it.each([
		{
			change: "a title",
			from: 'https://example.com/p "Old title"',
			to: 'https://example.com/p "New title"',
		},
		{
			change: "a title's words",
			from: 'https://example.com/p "The old guide words"',
			to: 'https://example.com/p "The new guide text"',
		},
		{
			change: "an added title",
			from: "https://example.com/p",
			to: 'https://example.com/p "A title"',
		},
		{
			change: "a destination in angle brackets",
			from: "https://example.com/p",
			to: "<https://example.com/new path>",
		},
	])(
		"a usage it cannot rewrite saves what the document saves ($change)",
		({ from, to }) => {
			// Diffed word by word, the kept definition got its markers inside the
			// title or the brackets: it stopped parsing, or the title saved a
			// `<del>` fragment.
			const define = (destination: string) =>
				`Intro.\n\nAs the paper [1]: says, the results hold. See [1] again.\n\n[1]: ${destination}`;
			const after = define(to);
			const { review, hrefs, saved } = loadAndSave(
				diffPartialText(define(from), after, true),
			);
			const direct = loadAndSave(after);

			// The usage left as written resolves as the saved document's does;
			// the rewritten one shows its old and new link.
			expect(hrefs[0]).toBe(direct.hrefs[0]);
			expect(hrefs.join(" ")).not.toMatch(MARKER_DAMAGE);
			expect(saved).toBe(direct.saved);
			expect(saved).not.toMatch(/<del|<ins|diff-(?:del|ins)/);
			expect(saved).not.toMatch(MARKER_DAMAGE);
			expect(review).not.toMatch(/title="[^"]*(?:&lt;|<)(?:del|ins)/);
		},
	);

	it.each([
		{
			name: "a usage in a table cell",
			define: (url: string) =>
				`Intro.\n\n| Name | Link |\n| --- | --- |\n| Pay | [guide] |\n\n[guide]: ${url}`,
		},
		{
			name: "a definition in a list item",
			define: (url: string) =>
				`See [guide] for details.\n\n- [guide]: ${url}`,
		},
		{
			name: "a definition indented in a list item",
			define: (url: string) => `- See [guide].\n\n  [guide]: ${url}`,
		},
		{
			name: "a definition with its title on the next line",
			define: (url: string) =>
				`See [guide] for details.\n\n[guide]: ${url}\n"The guide"`,
		},
		{
			name: "a definition in a blockquote",
			define: (url: string) =>
				`See [guide] for details.\n\n> [guide]: ${url}`,
		},
		{
			name: "a blockquote's definition before an unchanged top-level one",
			define: (url: string) =>
				`See [guide] for details.\n\n> [guide]: ${url}\n\n[guide]: https://example.com/top`,
		},
	])(
		"$name: a changed host reviews and saves the new destination",
		({ define }) => {
			const after = define(NEW_URL);
			const { hrefs, saved } = accept(define(OLD_URL), after);
			const direct = loadAndSave(after);

			expect(saved).toBe(direct.saved);
			expect(hrefs).toEqual(direct.hrefs);
			expect(hrefs).toContain(NEW_URL);
			expect(saved).not.toMatch(MARKER_DAMAGE);
		},
	);

	it("a usage in a table cell keeps the definition a rewritten usage would drop", () => {
		// The paragraph's usage is rewritten inline; the cell's is not, so the
		// definitions stay for it.
		const define = (url: string) =>
			`See [guide] above.\n\n| Name | Link |\n| --- | --- |\n| Pay | [guide] |\n\n[guide]: ${url}`;
		const after = define(NEW_URL);
		const { hrefs, saved } = accept(define(OLD_URL), after);

		expect(hrefs).toEqual([OLD_URL, NEW_URL, NEW_URL]);
		expect(saved).toBe(loadAndSave(after).saved);
		expect(saved).toContain(`| Pay | [guide](${NEW_URL}) |`);
	});

	it.each([
		{
			name: "on the next line",
			define: (title: string) =>
				`See [guide] for details.\n\n[guide]: ${OLD_URL}\n"${title}"`,
		},
		{
			name: "in a blockquote",
			define: (title: string) =>
				`See [guide] for details.\n\n> [guide]: ${OLD_URL} "${title}"`,
		},
		{
			name: "in a list item",
			define: (title: string) =>
				`See [guide].\n\n1. [guide]: ${OLD_URL} "${title}"`,
		},
	])(
		"a definition's title $name: a changed title saves the new one",
		({ define }) => {
			const after = define("The new guide text");
			const { hrefs, saved } = accept(
				define("The old guide words"),
				after,
			);
			const direct = loadAndSave(after);

			expect(saved).toBe(direct.saved);
			expect(hrefs).toEqual(direct.hrefs);
			expect(saved).toContain('"The new guide text"');
			expect(saved).not.toMatch(/<del|<ins|diff-(?:del|ins)/);
		},
	);

	it("leaves a changed label alone when a blockquote defines it first", () => {
		// markdown-it reads the first definition, the one in the quote, so a
		// change to the later one changes no link.
		const define = (url: string) =>
			`See [guide] for details.\n\n> [guide]: https://example.com/quoted\n\n[guide]: ${url}`;
		const after = define(NEW_URL);
		const { hrefs, saved } = accept(define(OLD_URL), after);

		expect(hrefs).toEqual(["https://example.com/quoted"]);
		expect(saved).toBe(loadAndSave(after).saved);
	});
});

describe("editor-markdown-save: a reference link in unchanged text (Fizzy #2946)", () => {
	// Only a label whose definition changed is rewritten inline. Anywhere
	// else markdown-it can read a reference differently from a rewrite, and
	// the accept used to lose the link or change the text. An unrelated
	// edit elsewhere makes sure the document is diffed.
	const edited = (stored: string) =>
		stored.replace("Intro.", "Introduction.");

	it.each([
		{
			name: "a usage followed by a colon",
			stored: "Intro.\n\nAs the paper [1]: says, the results hold.\n\n[1]: https://example.com/paper",
			href: "https://example.com/paper",
		},
		{
			name: "an inline destination markdown-it refuses",
			stored: "Intro.\n\nSee [guide](see below) for details.\n\n[guide]: https://example.com/g",
			href: "https://example.com/g",
		},
		{
			name: "a definition with its title on the next line",
			stored: 'Intro.\n\nSee [guide] for details.\n\n[guide]: https://example.com/g\n"The guide"',
			href: "https://example.com/g",
		},
		{
			name: "a table cell whose destination holds a pipe",
			stored: "Intro.\n\n| Name | Link |\n| --- | --- |\n| Pay | [guide] |\n\n[guide]: https://example.com/a|b",
			href: "https://example.com/a%7Cb",
		},
		{
			name: "a definition in a blockquote before a top-level one",
			stored: "Intro.\n\nSee [guide] for details.\n\n> [guide]: https://example.com/quoted\n\n[guide]: https://example.com/top",
			href: "https://example.com/quoted",
		},
		{
			name: "a definition inside an HTML comment",
			stored: "Intro.\n\nSee [guide] for details.\n\n<!--\n\n[guide]: https://example.com/hidden\n-->\n\n[guide]: https://example.com/top",
			href: "https://example.com/top",
		},
		{
			name: "a javascript: definition",
			stored: "Intro.\n\nSee [guide] for details.\n\n[guide]: javascript:alert(1)",
			href: null,
		},
	])("$name: saves what the document saves", ({ stored, href }) => {
		const proposed = edited(stored);
		const { hrefs, saved } = loadAndSave(
			diffPartialText(stored, proposed, true),
		);
		const direct = loadAndSave(proposed);

		expect(saved).toBe(direct.saved);
		expect(hrefs).toEqual(direct.hrefs);
		if (href === null) {
			expect(hrefs).toEqual([]);
		} else {
			expect(hrefs).toContain(href);
		}
	});
});

describe("editor-markdown-save: a reference in a changed table (Fizzy #2946)", () => {
	// A changed table is rendered apart from the rest of the document, and
	// its cells did not see the document's definitions: the accept saved
	// `\[guide\]`.
	const GUIDE = "https://example.com/guide";
	const NEW_GUIDE = "https://new.example.com/guide";
	const table = (name: string) =>
		`| Name | Link |\n| --- | --- |\n| ${name} | [guide] |`;

	it.each([
		{
			name: "a definition after the table",
			define: (name: string, url: string) =>
				`Intro.\n\n${table(name)}\n\n[guide]: ${url}`,
			newUrl: GUIDE,
		},
		{
			name: "a definition before the table",
			define: (name: string, url: string) =>
				`Intro.\n\n[guide]: ${url}\n\n${table(name)}\n\nMore.`,
			newUrl: GUIDE,
		},
		{
			name: "a table that starts the document",
			define: (name: string, url: string) =>
				`${table(name)}\n\n[guide]: ${url}`,
			newUrl: GUIDE,
		},
		{
			name: "a changed definition host too",
			define: (name: string, url: string) =>
				`Intro.\n\n${table(name)}\n\n[guide]: ${url}`,
			newUrl: NEW_GUIDE,
		},
	])("$name: saves what the document saves", ({ define, newUrl }) => {
		const proposed = define("Pay now", newUrl);
		const { hrefs, saved } = loadAndSave(
			diffPartialText(define("Pay", GUIDE), proposed, true),
		);
		const direct = loadAndSave(proposed);

		expect(saved).toBe(direct.saved);
		expect(saved).toContain(`| Pay now | [guide](${newUrl}) |`);
		// The review shows the added table and the deleted one, and each
		// resolves its cell through the document's definition.
		expect(direct.hrefs).toEqual([newUrl]);
		expect(hrefs).toEqual([newUrl, newUrl]);
	});
});

describe("editor-markdown-save: an accepted change to a raw <a> element (Fizzy #2946)", () => {
	// Diffed word by word, a changed href got its markers inside the
	// attribute, where nothing parses them as a diff.
	const withAnchor = (url: string) =>
		`Intro.\n\nSee <a href="${url}">the docs</a> for details.\n\nOutro.`;

	it("saves the new link, with no marker inside an attribute", () => {
		const after = withAnchor("https://example.com/new");
		const { review, hrefs, saved } = loadAndSave(
			diffPartialText(withAnchor("https://example.com/old"), after, true),
		);

		expect(hrefs).toEqual([
			"https://example.com/old",
			"https://example.com/new",
		]);
		expect(review).not.toMatch(MARKER_DAMAGE);
		expect(saved).toBe(loadAndSave(after).saved);
		expect(saved).toContain(
			"See [the docs](https://example.com/new) for details.",
		);
		expect(saved).not.toContain("https://example.com/old");
		expect(saved).not.toMatch(MARKER_DAMAGE);
	});

	// Every reject-all handler renders the stored baseline again.
	it("reject-all keeps the old link", () => {
		expect(
			loadAndSave(withAnchor("https://example.com/old")).saved,
		).toContain("See [the docs](https://example.com/old) for details.");
	});
});

describe("editor-markdown-save: an accepted change to a mention (Fizzy #2946)", () => {
	const mention = (id: string, label: string) =>
		`<span data-type="mention" data-id="${id}" data-label="${label}" data-mention-id="m_example" class="mention">@${label}</span>`;
	const withMention = (id: string, label: string) =>
		`Intro.\n\nAsk ${mention(id, label)} to review.\n\nOutro.`;

	it("saves the new mention whole, with no marker inside an attribute", () => {
		const after = withMention("user-2", "Bob");
		const { review, saved } = loadAndSave(
			diffPartialText(withMention("user-1", "Alice"), after, true),
		);

		expect(review).not.toMatch(MARKER_DAMAGE);
		expect(saved).toBe(loadAndSave(after).saved);
		expect(saved).toContain('data-id="user-2"');
		expect(saved).not.toContain("user-1");
		expect(saved).not.toContain("Alice");
		expect(saved).not.toMatch(MARKER_DAMAGE);
	});
});

/**
 * The inline destinations in saved markdown, in order; an escaped `\\](`
 * is text, not a link.
 */
function savedDestinations(saved: string): string[] {
	return [...saved.matchAll(/(?<!\\)\]\(([^)\s]+)\)/g)].map(
		(match) => match[1],
	);
}

describe("editor-markdown-save: a destination one resolve used to leave half-resolved (Fizzy #2946)", () => {
	// One resolve pass used to join the halves around a lone encoded marker
	// into a new whole marker, so the save, resolving once more than the
	// review, stored a different destination. A lone marker now becomes a
	// hyphen, one pass leaves no marker behind, and the review and the save
	// keep the same destination.
	const ENC_DEL_START = "%E2%80%8B%E2%80%8BDEL_START%E2%80%8B%C2%A0";
	const ENC_DEL_END = "%C2%A0%E2%80%8BDEL_END%E2%80%8B%E2%80%8B";
	const LONE_ADD_END = "%C2%A0%E2%80%8BADD_END%E2%80%8B%E2%80%8B";
	/** `url` with every marker word split by a marker one resolve removes. */
	const split = (url: string) =>
		url.replace(
			/(?:ADD|DEL)_(?:START|END)/g,
			(word) => `${word.slice(0, 5)}${LONE_ADD_END}${word.slice(5)}`,
		);
	// Resolved twice, a link to evil.example; resolved once, its host is
	// trusted.example.com.
	const HIDDEN = `https://evil.example${ENC_DEL_START}@trusted.example.com/x${ENC_DEL_END}/pay`;

	it.each([
		{
			path: "proposed through the diff",
			markdown: diffPartialText(
				"Pay the deposit.",
				`[Pay the deposit](${split(split(HIDDEN))}).`,
				true,
			),
		},
		{
			path: "loaded as stored",
			markdown: `[Pay the deposit](${split(HIDDEN)}).`,
		},
	])("reviews the destination the save stores ($path)", ({ markdown }) => {
		const { hrefs, saved } = loadAndSave(markdown);

		expect(hrefs).toHaveLength(1);
		expect(savedDestinations(saved)).toEqual(hrefs);
		expect(saved).not.toContain("(https://evil.example/pay)");
	});
});

describe("editor-markdown-save: a hidden host in a changed table, a raw anchor or a raw image (Fizzy #2946)", () => {
	// The review must show the destination the save stores wherever the
	// diff renders a link: a changed table is rendered on its own, and raw
	// HTML keeps its attributes as written.
	const ENC_DEL_START = "%E2%80%8B%E2%80%8BDEL_START%E2%80%8B%C2%A0";
	const ENC_DEL_END = "%C2%A0%E2%80%8BDEL_END%E2%80%8B%E2%80%8B";
	const LONE_ADD_END = "%C2%A0%E2%80%8BADD_END%E2%80%8B%E2%80%8B";
	const NBSP = decodeURIComponent("%C2%A0");
	const hidden = (start: string, end: string, path = "/pay") =>
		`https://evil.example${start}@trusted.example.com/x${end}${path}`;
	/** `url` with every marker word split by a marker one resolve removes. */
	const split = (url: string) =>
		url.replace(
			/(?:ADD|DEL)_(?:START|END)/g,
			(word) => `${word.slice(0, 5)}${LONE_ADD_END}${word.slice(5)}`,
		);
	const table = (destination: string) =>
		`Intro.\n\n| Name | Link |\n| --- | --- |\n| Pay | [the deposit](${destination}) |\n\nOutro.`;

	it.each([
		{ spelling: "encoded", start: ENC_DEL_START, end: ENC_DEL_END },
		{
			spelling: "raw",
			start: decodeURIComponent(ENC_DEL_START),
			end: decodeURIComponent(ENC_DEL_END),
		},
		{
			spelling: "partly encoded",
			start: ENC_DEL_START.replace("%C2%A0", NBSP),
			end: ENC_DEL_END.replace("%C2%A0", NBSP),
		},
	])(
		"reviews the table link the save stores ($spelling)",
		({ start, end }) => {
			const { hrefs, saved } = loadAndSave(
				diffPartialText(
					table("https://example.com/old"),
					table(hidden(start, end)),
					true,
				),
			);

			expect(
				hrefs.filter((href) => href.includes("trusted.example.com")),
			).toEqual([]);
			expect(hrefs).toContain("https://evil.example/pay");
			expect(saved).toContain(
				"| Pay | [the deposit](https://evil.example/pay) |",
			);
		},
	);

	it.each([
		{
			shape: "an encoded run",
			destination: hidden(ENC_DEL_START, ENC_DEL_END),
		},
		{
			shape: "a run split once",
			destination: split(hidden(ENC_DEL_START, ENC_DEL_END)),
		},
		{
			shape: "a run split twice",
			destination: split(split(hidden(ENC_DEL_START, ENC_DEL_END))),
		},
	])(
		"reviews the raw anchor's destination the save stores ($shape)",
		({ destination }) => {
			const { hrefs, saved } = loadAndSave(
				diffPartialText(
					"Pay the deposit.",
					`<a href="${destination}">Pay the deposit</a>.`,
					true,
				),
			);

			expect(hrefs).toHaveLength(1);
			expect(savedDestinations(saved)).toEqual(hrefs);
		},
	);

	it.each([
		{
			shape: "an encoded run",
			source: hidden(ENC_DEL_START, ENC_DEL_END, "/a.png"),
		},
		{
			shape: "a run split once",
			source: split(hidden(ENC_DEL_START, ENC_DEL_END, "/a.png")),
		},
		{
			shape: "a run split twice",
			source: split(split(hidden(ENC_DEL_START, ENC_DEL_END, "/a.png"))),
		},
	])(
		"reviews the raw image's source the save stores ($shape)",
		({ source }) => {
			const { review, saved } = loadAndSave(
				diffPartialText(
					"Intro.\n\nOutro.",
					`Intro.\n\n<img src="${source}" alt="" width="320" />\n\nOutro.`,
					true,
				),
			);
			const sources = (html: string) =>
				[...html.matchAll(/<img\b[^>]*?\ssrc="([^"]*)"/g)].map(
					(match) => match[1],
				);

			expect(sources(review)).toHaveLength(1);
			expect(sources(saved)).toEqual(sources(review));
		},
	);
});
