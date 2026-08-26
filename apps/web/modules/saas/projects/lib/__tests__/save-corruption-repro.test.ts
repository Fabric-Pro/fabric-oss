/**
 * Reproduction tests for the v2 → v3 formatting corruption seen on
 * document cmnte5bei000g8sv8d8rtnmlr. The saved markdown had:
 *   - `**Impact****:**` and `**Discovery phase delays****:**`
 *     (two adjacent `<strong>` tags left behind after a diff tag was
 *     removed from inside the bold).
 *   - `then\*\*` (escaped asterisks that render as literal `**`) —
 *     same adjacent-strong pattern with a literal `*` leaking into a
 *     text node that turndown then escaped.
 *   - A numbered list flattened into a `1\. First 2. Second 3. Third`
 *     paragraph because the diffMarkerPlugin is inline-only and a
 *     multi-line ADD block got collapsed to one paragraph.
 *
 * Two fixes make these pass:
 *   - `stripDiffTags` now merges strictly-adjacent same-tag runs
 *     (`</strong><strong>` → ``) so a bold that was split by a diff
 *     mark becomes a single run again.
 *   - `fromMarkdown` pre-splits multi-line ADD/DEL blocks so each
 *     non-empty line carries its own inline diff marker after the
 *     block marker (list `1.`, heading `#`, blockquote `>`).
 */

import { Editor } from "@tiptap/core";
import TurndownService from "turndown";
// @ts-expect-error - turndown-plugin-gfm has no types
import { gfm } from "turndown-plugin-gfm";
import { describe, expect, it } from "vitest";
import { diffPartialText, fromMarkdown } from "../diff-utils";
import { applyGfmStrikethroughFix, stripDiffTags } from "../editor-save-utils";
import { advancedExtensions } from "../tiptap-extensions-advanced";

function createEditor(html = ""): Editor {
	return new Editor({
		extensions: advancedExtensions,
		content: html,
	});
}

function createTurndown(): TurndownService {
	const service = new TurndownService({
		headingStyle: "atx",
		codeBlockStyle: "fenced",
		bulletListMarker: "-",
		emDelimiter: "*",
	});
	service.use(gfm);
	applyGfmStrikethroughFix(service);
	return service;
}

// Full save path: editor → stripDiffTags → turndown
function saveEditor(editor: Editor): string {
	const html = editor.getHTML();
	const sanitized = stripDiffTags(html);
	return createTurndown().turndown(sanitized);
}

// End-to-end: baseline → AI output → diffPartialText → fromMarkdown →
// editor → accept (stripDiffTags) → turndown. This is the full user flow.
function simulateAcceptFlow(baseline: string, aiOutput: string): string {
	const diff = diffPartialText(baseline, aiOutput, true);
	const html = fromMarkdown(diff);
	const editor = createEditor(html);
	const saved = saveEditor(editor);
	editor.destroy();
	return saved;
}

describe("v3 corruption reproductions", () => {
	describe("adjacent <strong> → ****...**", () => {
		it("preserves a single merged strong when the editor sees adjacent ones", () => {
			// Simulates editor state after an edit that split a bold across
			// two adjacent <strong> tags (e.g. because a diff mark landed
			// between "Impact" and ":" and then got stripped).
			const editor = createEditor(
				"<p><strong>Impact</strong><strong>:</strong> text.</p>",
			);
			const markdown = saveEditor(editor);
			// The CORRECT output is `**Impact:**` — TipTap should merge the
			// adjacent marks into one run.
			expect(markdown).toContain("**Impact:**");
			// Must NOT produce the corrupted `**Impact****:**` form.
			expect(markdown).not.toContain("**Impact****:**");
			expect(markdown).not.toMatch(/\*{4}/);
			editor.destroy();
		});
	});

	describe("literal asterisks in text get escaped", () => {
		it("escapes literal ** in a text node", () => {
			// If the editor HTML has a literal `**` in a text node (no
			// surrounding <strong>), turndown will escape it as `\*\*`.
			// This is turndown's default behavior — desirable for literal
			// text, but catastrophic if the ** was SUPPOSED to be bold.
			const editor = createEditor("<p>then ** development teams</p>");
			const markdown = saveEditor(editor);
			// Document the current behavior:
			expect(markdown).toMatch(/then \\?\*\\?\* development teams/);
			editor.destroy();
		});
	});

	describe("diff markers splitting bold regions", () => {
		it("full save round-trip: bold spans a diff deletion", () => {
			// baseline: `**Quantified impact:** text`
			// new:      `**Impact:** text`
			// The diff inserts DEL markers inside the bold span.
			const diffed =
				"**\u200B\u200BDEL_START\u200B\u00A0Quantified \u00A0\u200BDEL_END\u200B\u200BImpact:** Organizations lose";
			const editor = createEditor(fromMarkdown(diffed));
			const saved = saveEditor(editor);
			expect(saved).toContain("**Impact:**");
			expect(saved).not.toMatch(/\*{4}/);
			expect(saved).not.toMatch(/\\\*/);
			editor.destroy();
		});

		it("full save round-trip: addition splits bold", () => {
			// baseline: `**Impact:** text`
			// new:      `**Extended Impact:** text`
			const diffed =
				"**\u200B\u200BADD_START\u200B\u00A0Extended \u00A0\u200BADD_END\u200B\u200BImpact:** text";
			const editor = createEditor(fromMarkdown(diffed));
			const saved = saveEditor(editor);
			expect(saved).toContain("**Extended Impact:**");
			expect(saved).not.toMatch(/\*{4}/);
			expect(saved).not.toMatch(/\\\*/);
			editor.destroy();
		});

		it("full save round-trip: deletion crosses bold boundary", () => {
			// Deletion spans the closing `**`, so the bold wrapper is gone
			// on both sides of the accepted content.
			const diffed =
				"text \u200B\u200BDEL_START\u200B\u00A0**bold phrase** \u00A0\u200BDEL_END\u200B\u200Bthen \u200B\u200BADD_START\u200B\u00A0less \u00A0\u200BADD_END\u200B\u200B\u200B\u200BDEL_START\u200B\u00A0more \u00A0\u200BDEL_END\u200B\u200Btext";
			const editor = createEditor(fromMarkdown(diffed));
			const saved = saveEditor(editor);
			expect(saved).not.toMatch(/\\\*/);
			expect(saved).not.toMatch(/\*{4}/);
			editor.destroy();
		});
	});

	describe("diff-wrapped ordered list → flattened list", () => {
		it("ADD block wrapping an entire numbered list", () => {
			// Simulates AI replacing prose with a numbered list.
			const diffed = `Some intro.

\u200B\u200BADD_START\u200B\u00A01. First item
2. Second item
3. Third item
\u00A0\u200BADD_END\u200B\u200B

Outro.`;
			const editor = createEditor(fromMarkdown(diffed));
			const saved = saveEditor(editor);
			// No escaped list markers.
			expect(saved).not.toMatch(/1\\\./);
			// The list structure is preserved.
			expect(saved).toMatch(/^\s*1\.\s+First item/m);
			expect(saved).toMatch(/^\s*2\.\s+Second item/m);
			expect(saved).toMatch(/^\s*3\.\s+Third item/m);
			editor.destroy();
		});

		it("ADD block wrapping a fenced code block preserves the fence", () => {
			// Regression: splitMultilineDiffBlocks used to wrap the fence
			// markers themselves, producing `ADD_START```bashADD_END` and
			// breaking MarkdownIt's fence recognition. The fence must stay
			// atomic — its lines pass through unwrapped so markdown-it's
			// block parser still sees an opener/closer pair and renders a
			// real `<pre><code>` block.
			const diffed = `Intro.

\u200B\u200BADD_START\u200B\u00A0\`\`\`bash
echo hello
npm install
\`\`\`
\u00A0\u200BADD_END\u200B\u200B

Outro.`;
			const html = fromMarkdown(diffed);
			expect(html).toMatch(/<pre[^>]*>[\s\S]*<code/);
			expect(html).toContain("echo hello");
			expect(html).toContain("npm install");
			// The fence content must NOT be rendered as inline code in a
			// paragraph (which is the broken-split failure mode).
			expect(html).not.toMatch(/<p[^>]*>[^<]*echo hello/);

			const editor = createEditor(html);
			const saved = saveEditor(editor);
			// Save-path should preserve the fence as a proper code block.
			expect(saved).toMatch(/```(?:bash)?\s*\necho hello/);
			expect(saved).toContain("npm install");
			// No zero-width chars or stray ADD markers leaking out.
			expect(saved).not.toMatch(/ADD_START|ADD_END/);
			editor.destroy();
		});

		it("ADD block with prose before AND after a fenced code block", () => {
			// Mixed content: prose lines should be diff-wrapped, fence lines
			// should pass through unwrapped.
			const diffed = `Original paragraph.

\u200B\u200BADD_START\u200B\u00A0New intro line.
\`\`\`bash
echo hi
\`\`\`
New outro line.\u00A0\u200BADD_END\u200B\u200B

Footer.`;
			const html = fromMarkdown(diffed);
			expect(html).toMatch(/<pre[^>]*>[\s\S]*<code/);
			expect(html).toContain("echo hi");
			// Prose lines outside the fence get diff-highlighted.
			expect(html).toMatch(
				/<ins[^>]*class="[^"]*diff-ins[^"]*"[^>]*>New intro line\.<\/ins>/,
			);
			expect(html).toMatch(
				/<ins[^>]*class="[^"]*diff-ins[^"]*"[^>]*>New outro line\.<\/ins>/,
			);

			const editor = createEditor(html);
			const saved = saveEditor(editor);
			expect(saved).toContain("New intro line.");
			expect(saved).toContain("New outro line.");
			expect(saved).toMatch(/```(?:bash)?\s*\necho hi/);
			expect(saved).not.toMatch(/ADD_START|ADD_END/);
			editor.destroy();
		});

		it("DEL block wrapping a fenced code block removes the code on save", () => {
			// Pure DEL-wrapped fences are extracted pre-markdown and
			// reinjected as `<p><del class="diff-del">line</del></p>` per
			// line. (A wrapper div is dropped by TipTap during parse, and
			// wrapping in `<code>` would strip DiffDelete because Code is
			// an exclusive mark.) stripDiffTags removes every
			// `<del class="diff-del">...</del>` on save, leaving only the
			// intro and outro paragraphs.
			const diffed = `Intro.

\u200B\u200BDEL_START\u200B\u00A0\`\`\`bash
old command
second line
\`\`\`
\u00A0\u200BDEL_END\u200B\u200B

Outro.`;
			const editor = createEditor(fromMarkdown(diffed));
			const saved = saveEditor(editor);
			expect(saved).not.toContain("old command");
			expect(saved).not.toContain("second line");
			expect(saved).toContain("Intro.");
			expect(saved).toContain("Outro.");
			expect(saved).not.toMatch(/DEL_START|DEL_END/);
			editor.destroy();
		});

		it("DEL block wrapping mixed prose AND a fenced code block", () => {
			// Mixed DEL content: deleted prose, then a deleted fence, then
			// more deleted prose, all inside one DEL region. Before the
			// Phase-B mixed extraction, `splitMultilineDiffBlocks` wrapped
			// every line individually (including fence openers), so
			// MarkdownIt saw garbage like `DEL_START```bashDEL_END` and
			// emitted malformed HTML with `<del>` tags crossing `<p>` and
			// `<pre><code>` boundaries. After the fix, the fence is
			// extracted to its own placeholder and surrounding prose gets
			// its own DEL_START/DEL_END pairs, so each deletion is a
			// well-formed `<p><del class="diff-del">...</del></p>` that
			// `stripDiffTags` removes cleanly on save.
			const diffed = `Intro.

\u200B\u200BDEL_START\u200B\u00A0Deleted prose line.
\`\`\`bash
old command
second line
\`\`\`
More deleted prose.\u00A0\u200BDEL_END\u200B\u200B

Outro.`;
			const html = fromMarkdown(diffed);
			// No crossed tags: every <del class="diff-del"> is closed
			// inside the same <p> it opened in.
			expect(html).not.toMatch(/<del[^>]*><\/p>/);
			expect(html).not.toMatch(/<pre[^>]*>[\s\S]*<\/del>[\s\S]*<\/pre>/);
			// Deleted content must be properly wrapped.
			expect(html).toMatch(
				/<del[^>]*class="[^"]*diff-del[^"]*"[^>]*>Deleted prose line\.<\/del>/,
			);
			expect(html).toMatch(
				/<del[^>]*class="[^"]*diff-del[^"]*"[^>]*>old command<\/del>/,
			);
			expect(html).toMatch(
				/<del[^>]*class="[^"]*diff-del[^"]*"[^>]*>More deleted prose\.<\/del>/,
			);

			const editor = createEditor(html);
			const saved = saveEditor(editor);
			// Every piece of deleted content is gone.
			expect(saved).not.toContain("Deleted prose line.");
			expect(saved).not.toContain("old command");
			expect(saved).not.toContain("second line");
			expect(saved).not.toContain("More deleted prose.");
			// Intro and outro survive unescaped.
			expect(saved).toContain("Intro.");
			expect(saved).toContain("Outro.");
			expect(saved).not.toMatch(/DEL_START|DEL_END/);
			editor.destroy();
		});

		it("DEL block wrapping an entire bulleted list", () => {
			const diffed = `Intro.

\u200B\u200BDEL_START\u200B\u00A0- First
- Second
- Third
\u00A0\u200BDEL_END\u200B\u200B

Outro.`;
			const editor = createEditor(fromMarkdown(diffed));
			const saved = saveEditor(editor);
			// After accept, the deleted list items should be GONE,
			// but the intro/outro should remain intact (not escaped).
			expect(saved).not.toMatch(/First/);
			expect(saved).not.toMatch(/Second/);
			expect(saved).not.toMatch(/Third/);
			expect(saved).toContain("Intro.");
			expect(saved).toContain("Outro.");
			editor.destroy();
		});
	});

	describe("end-to-end: real baseline vs new AI output", () => {
		// These drive the whole diffPartialText → fromMarkdown → editor →
		// stripDiffTags → turndown pipeline with realistic before/after
		// strings. They're the closest thing to an integration test for
		// the v3 bug on document cmnte5bei000g8sv8d8rtnmlr.

		it("rewriting a bold phrase does not fragment the bold or escape asterisks", () => {
			const baseline =
				"Organizations today face critical challenges.\n\n**Quantified impact:** Teams lose 10-20% of development time.\n";
			const aiOutput =
				"Organizations struggle with bottlenecks.\n\n**Impact:** Teams lose 10-20% of development time.\n";
			const saved = simulateAcceptFlow(baseline, aiOutput);
			expect(saved).toContain("**Impact:**");
			expect(saved).not.toMatch(/\*{4}/); // no ****
			expect(saved).not.toMatch(/\\\*/); // no \*
			// Bold should wrap the whole "Impact:" label.
			expect(saved).toContain("**Impact:** Teams lose");
		});

		it("replacing prose with a numbered list preserves list structure", () => {
			const baseline = `Teams face challenges including documentation debt and manual work.

Things are hard.`;
			const aiOutput = `Teams face three critical bottlenecks:

1. Documentation debt from outdated specs
2. Manual work on routine tasks
3. Context fragmentation across tools

Things are hard.`;
			const saved = simulateAcceptFlow(baseline, aiOutput);
			// List markers survive as real list items.
			expect(saved).not.toMatch(/\d+\\\./);
			expect(saved).toMatch(/^\s*1\.\s+Documentation debt/m);
			expect(saved).toMatch(/^\s*2\.\s+Manual work/m);
			expect(saved).toMatch(/^\s*3\.\s+Context fragmentation/m);
		});

		it("inserting a bold word into an existing bold phrase keeps it as one bold", () => {
			const baseline = "**Important:** Teams need clear specs.";
			const aiOutput =
				"**Critically Important:** Teams need clear specs.";
			const saved = simulateAcceptFlow(baseline, aiOutput);
			expect(saved).toContain("**Critically Important:**");
			expect(saved).not.toMatch(/\*{4}/);
			expect(saved).not.toMatch(/\\\*/);
		});
	});

	// Issue #766. When `diffPartialText` produces `<DEL>old para</DEL># <ADD>title</ADD>`
	// or `<DEL>old para</DEL>1. <ADD>item</ADD>` on a single line — the shape
	// AI stage-enhance flows produce when REPLACING existing content with a
	// new heading or list — `reconstructBrokenStructureLines` used to bail on
	// its fast path because both the marker-stripped and unstripped versions
	// classified as paragraph (the line begins with marker chars, not the
	// structural prefix). The line went through MarkdownIt as a paragraph and
	// Turndown's defensive `^# ` / `^\d+\. ` escape demoted the block on save.
	describe("DEL+ADD on same line crossing a block boundary (#766)", () => {
		it("paragraph → heading: `<DEL>old</DEL># <ADD>title</ADD>` round-trips as a heading", () => {
			const baseline = "Old content here.\n";
			const aiOutput = "# Passive Analysis: Agent KB\n\nBody paragraph.";
			const saved = simulateAcceptFlow(baseline, aiOutput);
			expect(saved).toMatch(/^# Passive Analysis: Agent KB/);
			expect(saved).not.toContain("\\#");
		});

		it("paragraph → ordered list: numbered items round-trip as `<ol>`, not flattened paragraph", () => {
			const baseline = "Old content here.\n";
			const aiOutput =
				"1. First question\n2. Second question with **bold** text\n3. Third question";
			const saved = simulateAcceptFlow(baseline, aiOutput);
			// Each item must round-trip as an ordered-list line, not as
			// `1\. First …` paragraph text or as a flattened single paragraph
			// with all three items concatenated.
			expect(saved).not.toMatch(/^\d+\\\./m);
			expect(saved).toMatch(/^1\.\s+First question/m);
			expect(saved).toMatch(
				/^2\.\s+Second question with \*\*bold\*\* text/m,
			);
			expect(saved).toMatch(/^3\.\s+Third question/m);
		});

		it("regression guard: heading content edit leaves heading kind unchanged", () => {
			// `# Old Title` → `# New Title` keeps both sides as headings; the
			// slow path's blockKindsEqual check should output the line as-is.
			const baseline = "# Old Title\n\nBody.";
			const aiOutput = "# New Title\n\nBody.";
			const saved = simulateAcceptFlow(baseline, aiOutput);
			expect(saved).toMatch(/^# New Title/);
			expect(saved).not.toContain("\\#");
		});

		it("regression guard: heading-level change still works (## → #)", () => {
			const baseline = "## Existing Title\n\nBody.";
			const aiOutput = "# Existing Title\n\nBody.";
			const saved = simulateAcceptFlow(baseline, aiOutput);
			expect(saved).toMatch(/^# Existing Title/);
			expect(saved).not.toContain("\\#");
		});
	});
});

/**
 * An AI edit that inserts an acceptance criterion mid-list renumbers every
 * item below it. The word diff splits the marker's digits across DEL and
 * ADD (`3<DEL>7</DEL><ADD>8</ADD>.  GIVEN …`), so the line no longer starts
 * with `NN. `, MarkdownIt parses a paragraph, and Turndown's defensive
 * ordered-marker escape saves it as `38\. GIVEN …`. The item's continuation
 * lines keep their five-space list indent, which — outside a list item — is
 * an indented code block, so the prose ends up sealed in a fence on the
 * next round trip.
 */
describe("ordered-list renumber through the diff/accept path", () => {
	it("keeps a renumbered item a list item instead of an escaped paragraph", () => {
		const baseline =
			"### Work Capture\n\n37. GIVEN no chat app is configured\n\n38. GIVEN chat setup is missing\n";
		const aiOutput =
			"### Work Capture\n\n38. GIVEN no chat app is configured\n\n39. GIVEN chat setup is missing\n";
		const saved = simulateAcceptFlow(baseline, aiOutput);
		expect(saved).not.toMatch(/^\d+\\\./m);
		expect(saved).toMatch(/^38\.\s+GIVEN no chat app is configured/m);
		expect(saved).toMatch(/^39\.\s+GIVEN chat setup is missing/m);
	});

	it("repairs a single-digit renumber the same way", () => {
		const baseline = "8. GIVEN the first condition\n";
		const aiOutput = "9. GIVEN the first condition\n";
		const saved = simulateAcceptFlow(baseline, aiOutput);
		expect(saved).not.toMatch(/^\d+\\\./m);
		expect(saved).toMatch(/^9\.\s+GIVEN the first condition/m);
	});

	it("keeps a renumbered item's continuation prose out of a code fence", () => {
		const baseline =
			"37. GIVEN no chat app is configured\n\n    WHEN a user attempts active chat work capture\n\n    THEN Fabric blocks capture.\n";
		const aiOutput =
			"38. GIVEN no chat app is configured\n\n    WHEN a user attempts active chat work capture\n\n    THEN Fabric blocks capture.\n";
		const saved = simulateAcceptFlow(baseline, aiOutput);
		expect(saved).not.toContain("```");
		expect(saved).not.toMatch(/^\d+\\\./m);
		expect(saved).toContain(
			"WHEN a user attempts active chat work capture",
		);
	});

	it("keeps an indented continuation inside its item when the whole block is added", () => {
		const baseline = "## Work Capture\n\nIntro paragraph.\n";
		const aiOutput =
			"## Work Capture\n\nIntro paragraph.\n\n39. GIVEN chat setup is missing in Settings\n\n    WHEN the user opens the capture panel\n";
		const diff = diffPartialText(baseline, aiOutput, true);
		const html = fromMarkdown(diff);
		// The continuation must stay inside the list item rather than being
		// hoisted out as a sibling paragraph at column zero.
		expect(html).toMatch(
			/<li>[\s\S]*WHEN the user opens the capture panel[\s\S]*<\/li>/,
		);
	});

	it("stays clean across repeated renumbering edits", () => {
		// The report is that the artifacts persist across versions: each edit
		// feeds the previous save back in, so damage compounds. Drive several
		// generations and require the shape to hold.
		let current =
			"37. GIVEN no chat app is configured\n\n    WHEN a user attempts capture\n\n38. GIVEN chat setup is missing\n";
		for (let generation = 0; generation < 3; generation++) {
			const renumbered = current.replace(
				/^(\d+)\./gm,
				(_match, digits) => `${Number(digits) + 1}.`,
			);
			current = simulateAcceptFlow(current, renumbered);
			expect(current).not.toMatch(/^\d+\\\./m);
			expect(current).not.toContain("```");
		}
		expect(current).toMatch(/^40\.\s+GIVEN no chat app is configured/m);
	});

	it("keeps deleted words visible when the marker delimiter changes", () => {
		// `37) Old` -> `38. New` fuses the marker and the word into one DEL
		// span. Hoisting the prefix must not swallow `Old` — the review view
		// is the whole point of the diff, so the removal has to stay visible.
		const baseline = "37) Old text\n";
		const aiOutput = "38. New text\n";
		const diff = diffPartialText(baseline, aiOutput, true);
		const html = fromMarkdown(diff);
		expect(html).toContain("Old");
		expect(html).toContain("diff-del");
		const saved = simulateAcceptFlow(baseline, aiOutput);
		expect(saved).not.toMatch(/^\d+\\\./m);
		expect(saved).toContain("New text");
	});

	it("does not fence an indented line added outside a list", () => {
		// At top level a four-space indent is an indented code block, so
		// hoisting it outside the diff marker would seal prose in a fence —
		// the exact artifact this fix removes, arriving from the other side.
		const baseline = "# T\n\nIntro.\n";
		const aiOutput = "# T\n\nIntro.\n\nPara.\n\n    indented note line\n";
		const saved = simulateAcceptFlow(baseline, aiOutput);
		expect(saved).not.toContain("```");
		expect(saved).toContain("indented note line");
	});

	it("regression guard: an unordered → ordered marker change still splits", () => {
		const baseline = "- GIVEN the first condition\n";
		const aiOutput = "1. GIVEN the first condition\n";
		// The kinds differ, so this must take the whole-line DEL/ADD split
		// path rather than the prefix hoist — both sides stay visible.
		const html = fromMarkdown(diffPartialText(baseline, aiOutput, true));
		expect(html).toContain("diff-del");
		expect(html).toContain("diff-ins");
		const saved = simulateAcceptFlow(baseline, aiOutput);
		expect(saved).toMatch(/^1\.\s+GIVEN the first condition/m);
		expect(saved).not.toMatch(/^\d+\\\./m);
	});

	it("regression guard: an inline edit inside a list item keeps its highlight", () => {
		const baseline = "38. GIVEN no chat app is configured\n";
		const aiOutput = "38. GIVEN no chat client is configured\n";
		const diff = diffPartialText(baseline, aiOutput, true);
		const html = fromMarkdown(diff);
		expect(html).toContain("diff-ins");
		// The item must still be a list item, not a paragraph — `<li>`
		// alone would pass for any list, so anchor on the start attribute.
		expect(html).toContain('<ol start="38"');
	});
});
