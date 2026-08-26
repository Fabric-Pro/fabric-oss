/**
 * Regression tests for the DiffInsert / DiffDelete TipTap mark priorities
 * and the class-based disambiguation from pasted bare `<del>`/`<ins>`.
 *
 * Background: TipTap StarterKit's Strike extension parses `<s>`, `<del>` AND
 * `<strike>` tags — all as strikethrough. Our custom `DiffDelete` mark also
 * parses `<del>`, but ONLY when the tag carries `class="diff-del"` (the class
 * is emitted by `fromMarkdown` for AI diff regions). Bare `<del>` from pasted
 * HTML (Google Docs, GitHub rendered markdown, etc.) must fall through to
 * Strike so it survives the save round-trip as user strikethrough.
 *
 * Both DiffInsert and DiffDelete carry `priority: 1000` so that when the
 * class does match, they unambiguously win over Strike.
 */

import { Editor } from "@tiptap/core";
import { describe, expect, it } from "vitest";
import { stripDiffTags } from "../editor-save-utils";
import { advancedExtensions } from "../tiptap-extensions-advanced";

function createEditor(html = ""): Editor {
	return new Editor({
		extensions: advancedExtensions,
		content: html,
	});
}

function collectMarkNames(editor: Editor): Set<string> {
	const markNames = new Set<string>();
	editor.state.doc.descendants((node) => {
		for (const mark of node.marks) {
			markNames.add(mark.type.name);
		}
	});
	return markNames;
}

describe("TipTap diff mark priorities", () => {
	it('parses <del class="diff-del"> as diffDelete, not strike', () => {
		const editor = createEditor(
			'<p>Keep <del class="diff-del">removed</del> text</p>',
		);
		const marks = collectMarkNames(editor);
		expect(marks.has("diffDelete")).toBe(true);
		expect(marks.has("strike")).toBe(false);
		editor.destroy();
	});

	it("parses bare <del> as strike (preserves pasted strikethrough)", () => {
		// Regression: pasted HTML from Google Docs / GitHub may contain bare
		// `<del>` tags. These must bind to Strike, NOT to DiffDelete, or they
		// would be deleted on save by the diffDelDrop turndown rule.
		const editor = createEditor("<p>Keep <del>removed</del> text</p>");
		const marks = collectMarkNames(editor);
		expect(marks.has("strike")).toBe(true);
		expect(marks.has("diffDelete")).toBe(false);
		editor.destroy();
	});

	it('parses <ins class="diff-ins"> as diffInsert', () => {
		const editor = createEditor(
			'<p>Keep <ins class="diff-ins">added</ins> text</p>',
		);
		const marks = collectMarkNames(editor);
		expect(marks.has("diffInsert")).toBe(true);
		editor.destroy();
	});

	it("still parses <s> as user strikethrough (Strike mark)", () => {
		const editor = createEditor("<p>Use <s>deprecated</s> carefully</p>");
		const marks = collectMarkNames(editor);
		expect(marks.has("strike")).toBe(true);
		expect(marks.has("diffDelete")).toBe(false);
		editor.destroy();
	});

	it("serializes diffDelete with diff-del class on getHTML()", () => {
		const editor = createEditor(
			'<p>Keep <del class="diff-del">removed</del> text</p>',
		);
		const html = editor.getHTML();
		expect(html).toMatch(
			/<del[^>]*class="[^"]*diff-del[^"]*"[^>]*>removed<\/del>/,
		);
		editor.destroy();
	});

	it("serializes diffInsert with diff-ins class on getHTML()", () => {
		const editor = createEditor(
			'<p>Keep <ins class="diff-ins">added</ins> text</p>',
		);
		const html = editor.getHTML();
		expect(html).toMatch(
			/<ins[^>]*class="[^"]*diff-ins[^"]*"[^>]*>added<\/ins>/,
		);
		editor.destroy();
	});

	it("stripDiffTags removes diffDelete content and unwraps diffInsert", () => {
		// The full save path: editor HTML → stripDiffTags → should leave the
		// "accepted" version (original + additions, minus deletions).
		const editor = createEditor(
			'<p>Teams <del class="diff-del">today </del><ins class="diff-ins">currently </ins>face challenges.</p>',
		);
		const stripped = stripDiffTags(editor.getHTML());
		// The deletion content ("today ") and its wrapping <del> tag must be gone.
		expect(stripped).not.toContain("today");
		expect(stripped).not.toMatch(/<del/);
		// The addition content ("currently ") must remain, its <ins> unwrapped.
		expect(stripped).toContain("currently");
		expect(stripped).not.toMatch(/<ins/);
		editor.destroy();
	});

	it("preserves user <s> strikethrough across a full editor → stripDiffTags round-trip", () => {
		const editor = createEditor(
			'<p>Use <s>old_api</s> and <del class="diff-del">some removed text</del> together.</p>',
		);
		const stripped = stripDiffTags(editor.getHTML());
		expect(stripped).toMatch(/<s[^>]*>old_api<\/s>/);
		expect(stripped).not.toContain("some removed text");
		expect(stripped).not.toMatch(/<del/);
		editor.destroy();
	});

	it("preserves pasted bare <del> across a full editor → stripDiffTags round-trip", () => {
		// Regression: pasted bare <del> must survive the save path as user
		// strikethrough. The editor binds it to Strike (which serializes as
		// `<s>`), and stripDiffTags leaves `<s>` alone.
		const editor = createEditor(
			"<p>Keep <del>pasted strikethrough</del> content</p>",
		);
		const stripped = stripDiffTags(editor.getHTML());
		expect(stripped).toContain("pasted strikethrough");
		expect(stripped).toMatch(/<s[^>]*>pasted strikethrough<\/s>/);
		editor.destroy();
	});

	// --- Inline code inside diff regions -----------------------------------
	// Regression for: "code snippets are not properly deleted" when approving
	// a deletion that wraps an inline `<code>` element. TipTap StarterKit's
	// Code mark defaults to `excludes: "_"` (excludes ALL other marks), which
	// silently drops DiffDelete from a code-marked text node during parse.
	// The Approve flow then can't find the code text as a deletion range and
	// it gets left behind in the document.

	it('parses <del class="diff-del"> wrapping inline <code> with BOTH marks on the code text', () => {
		const editor = createEditor(
			'<p>the pre-<del class="diff-del">empty <code>customInstructions</code></del><ins class="diff-ins">filled instructions</ins></p>',
		);

		// Walk every text node and verify the one whose text === "customInstructions"
		// carries both `code` AND `diffDelete` marks. Without the fix, only `code`
		// is present and the deletion mark is silently dropped.
		let codeNodeMarks: string[] = [];
		editor.state.doc.descendants((node) => {
			if (node.isText && node.text === "customInstructions") {
				codeNodeMarks = node.marks.map((m) => m.type.name);
			}
		});
		expect(codeNodeMarks).toContain("code");
		expect(codeNodeMarks).toContain("diffDelete");
		editor.destroy();
	});

	it("findDiffRanges-equivalent scan covers inline code inside a deletion", () => {
		// Mirrors the logic of findDiffRanges() in DiffReviewBar.tsx — scans
		// text nodes for diffInsert/diffDelete marks. The accepted deletion
		// range must cover BOTH the plain "empty " text AND the code-marked
		// "customInstructions" text, otherwise Approve leaves the code orphaned.
		const editor = createEditor(
			'<p>the pre-<del class="diff-del">empty <code>customInstructions</code></del> filled.</p>',
		);

		const deletionTextSegments: string[] = [];
		editor.state.doc.descendants((node) => {
			if (!node.isText) {
				return;
			}
			for (const mark of node.marks) {
				if (mark.type.name === "diffDelete") {
					deletionTextSegments.push(node.text ?? "");
				}
			}
		});

		// Both segments of the deletion must be detected.
		expect(deletionTextSegments).toEqual(
			expect.arrayContaining(["empty ", "customInstructions"]),
		);
		editor.destroy();
	});

	it('stripDiffTags removes inline <code> nested inside <del class="diff-del">', () => {
		// Save-path regression: the "accepted" HTML produced by stripDiffTags
		// must contain neither the deletion text nor the code snippet inside it.
		const editor = createEditor(
			'<p>the pre-<del class="diff-del">empty <code>customInstructions</code></del><ins class="diff-ins">filled instructions</ins> as a starting point.</p>',
		);
		const stripped = stripDiffTags(editor.getHTML());
		expect(stripped).not.toContain("empty");
		expect(stripped).not.toContain("customInstructions");
		expect(stripped).toContain("filled instructions");
		expect(stripped).not.toMatch(/<del/);
		expect(stripped).not.toMatch(/<ins/);
		editor.destroy();
	});
});

/**
 * Regression: user-typed text must be marked as a green `diffInsert` (a
 * proposed addition) so the user's in-place edits become real hunks for the
 * per-hunk Accept / Reject controls, and the diff counter stays honest.
 *
 * Combined coverage of:
 *  - typing in plain text creates a new green hunk
 *  - typing adjacent to an existing green range coalesces into one hunk
 *  - typing inside red splits red into `red ‖ green ‖ red`
 *  - the wholesale-replacement guard preserves AI streaming via setContent
 */
describe("DiffInsert / DiffDelete + user typing", () => {
	function findAllRanges(
		editor: Editor,
		markName: string,
	): { from: number; to: number }[] {
		const ranges: { from: number; to: number }[] = [];
		editor.state.doc.descendants((node, pos) => {
			if (!node.isText) {
				return;
			}
			for (const mark of node.marks) {
				if (mark.type.name === markName) {
					const last = ranges[ranges.length - 1];
					if (last && last.to === pos) {
						last.to = pos + node.nodeSize;
					} else {
						ranges.push({ from: pos, to: pos + node.nodeSize });
					}
				}
			}
		});
		return ranges;
	}

	it("typing immediately after a diffInsert span extends the green hunk", () => {
		const editor = createEditor(
			'<p>Keep <ins class="diff-ins">added</ins> text</p>',
		);
		const before = findAllRanges(editor, "diffInsert");
		expect(before.length).toBe(1);
		// Cursor at the right edge of "added", then type.
		editor
			.chain()
			.focus()
			.setTextSelection(before[0].to)
			.insertContent("XYZ")
			.run();

		// Still ONE green hunk — the typed text is sticked to the existing
		// green so the diff manager treats them as a single group.
		const after = findAllRanges(editor, "diffInsert");
		expect(after.length).toBe(1);
		expect(after[0].from).toBe(before[0].from);
		expect(after[0].to - after[0].from).toBe(
			before[0].to - before[0].from + 3,
		);
		expect(editor.getText()).toContain("addedXYZ");
		editor.destroy();
	});

	it("typing immediately after a diffDelete span creates a new green hunk", () => {
		const editor = createEditor(
			'<p>Keep <del class="diff-del">removed</del> text</p>',
		);
		const beforeRed = findAllRanges(editor, "diffDelete");
		expect(beforeRed.length).toBe(1);
		// Cursor at the right edge of "removed", then type.
		editor
			.chain()
			.focus()
			.setTextSelection(beforeRed[0].to)
			.insertContent("XYZ")
			.run();

		// Red unchanged.
		const afterRed = findAllRanges(editor, "diffDelete");
		expect(afterRed.length).toBe(1);
		expect(afterRed[0].from).toBe(beforeRed[0].from);
		expect(afterRed[0].to).toBe(beforeRed[0].to);
		// New green hunk for the typed characters, sitting right after the red.
		const green = findAllRanges(editor, "diffInsert");
		expect(green.length).toBe(1);
		expect(green[0].from).toBe(beforeRed[0].to);
		expect(green[0].to - green[0].from).toBe(3);
		editor.destroy();
	});

	it("typing inside a diffInsert span keeps it as a single green hunk", () => {
		// Cursor inside "added" → typed text inherits / is re-marked green so
		// the whole "adXYZded" remains one green group for the diff manager.
		const editor = createEditor('<p><ins class="diff-ins">added</ins></p>');
		const before = findAllRanges(editor, "diffInsert");
		expect(before.length).toBe(1);
		const middle = before[0].from + 2; // between 'a','d' and 'd','e','d'
		editor
			.chain()
			.focus()
			.setTextSelection(middle)
			.insertContent("XYZ")
			.run();

		const after = findAllRanges(editor, "diffInsert");
		expect(after.length).toBe(1);
		expect(after[0].to - after[0].from).toBe(
			before[0].to - before[0].from + 3,
		);
		expect(editor.getText()).toBe("adXYZded");
		editor.destroy();
	});

	it("typing inside a diffDelete span splits red into red ‖ green ‖ red", () => {
		const editor = createEditor(
			'<p><del class="diff-del">removed</del></p>',
		);
		const initialRed = findAllRanges(editor, "diffDelete");
		expect(initialRed.length).toBe(1);
		const middle = initialRed[0].from + 3; // between "rem" and "oved"
		editor
			.chain()
			.focus()
			.setTextSelection(middle)
			.insertContent("XYZ")
			.run();

		// Two red hunks now, separated by the green.
		const reds = findAllRanges(editor, "diffDelete");
		expect(reds.length).toBe(2);
		// One green hunk between them.
		const greens = findAllRanges(editor, "diffInsert");
		expect(greens.length).toBe(1);
		// Adjacency: end of first red == start of green, end of green ==
		// start of second red. This is what lets DiffReviewBar surface the
		// three independent hunks for Accept / Reject.
		expect(reds[0].to).toBe(greens[0].from);
		expect(greens[0].to).toBe(reds[1].from);
		expect(editor.getText()).toBe("remXYZoved");
		editor.destroy();
	});

	it("typing in plain text creates a new green hunk", () => {
		const editor = createEditor(
			'<p>Plain start. <ins class="diff-ins">added</ins> end.</p>',
		);
		const before = findAllRanges(editor, "diffInsert");
		expect(before.length).toBe(1);
		// Type at position 1 — well before any existing mark.
		editor.chain().focus().setTextSelection(1).insertContent("XYZ").run();

		// Two green hunks now: the typed one + the original (shifted right).
		const after = findAllRanges(editor, "diffInsert");
		expect(after.length).toBe(2);
		expect(after[0].from).toBe(1);
		expect(after[0].to - after[0].from).toBe(3);
		// Original hunk preserved (length unchanged), only its position shifted.
		expect(after[1].to - after[1].from).toBe(before[0].to - before[0].from);
		editor.destroy();
	});

	it("typing in a doc with no diff marks does NOT produce a green hunk", () => {
		// Active-diff guard: when no diffInsert/diffDelete exists anywhere
		// in the doc, the plugin must no-op so normal editing stays normal.
		// Without this guard, every keystroke in any document would produce
		// a green hunk and pollute the saved HTML with `<ins>` tags.
		const editor = createEditor("<p>Just plain text.</p>");
		expect(findAllRanges(editor, "diffInsert").length).toBe(0);
		editor.chain().focus().setTextSelection(1).insertContent("XYZ").run();
		expect(findAllRanges(editor, "diffInsert").length).toBe(0);
		expect(editor.getHTML()).not.toMatch(/<ins/);
		editor.destroy();
	});

	it("setContent that renders a fresh AI diff is NOT re-marked", () => {
		// Regression guard: MarkUserTypedAsDiffInsert must skip wholesale doc
		// replacements (setContent), or every red hunk in the AI's diff would
		// be flipped to green the moment it renders.
		const editor = createEditor("<p>Original.</p>");
		editor.commands.setContent(
			'<p>Was <del class="diff-del">old</del> <ins class="diff-ins">new</ins>.</p>',
		);
		const greens = findAllRanges(editor, "diffInsert");
		const reds = findAllRanges(editor, "diffDelete");
		expect(greens.length).toBe(1);
		expect(reds.length).toBe(1);
		expect(editor.getHTML()).toMatch(
			/<del[^>]*class="[^"]*diff-del[^"]*"[^>]*>old<\/del>/,
		);
		expect(editor.getHTML()).toMatch(
			/<ins[^>]*class="[^"]*diff-ins[^"]*"[^>]*>new<\/ins>/,
		);
		editor.destroy();
	});
});
