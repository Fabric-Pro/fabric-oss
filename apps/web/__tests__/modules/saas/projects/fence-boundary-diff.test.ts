/**
 * A deletion that spans a fence boundary still concatenates.
 *
 * This is a KNOWN, UNFIXED defect. It was previously recorded only in prose,
 * which meant nobody could see it without rebuilding the scenario by hand.
 * These cases pin the actual malformed output so whoever fixes it starts from
 * evidence and can tell immediately when the fix lands.
 *
 * The mechanism: the diff engine emits `<del class="diff-del">` inside one
 * block and its closing tag inside the next. TipTap parses HTML with the
 * browser's own parser (`DOMParser` via `elementFromString`), and per the HTML
 * tree-construction rules a block-level open tag implicitly closes an open
 * `<p>` — which pops every element above it, the unclosed `<del>` included. The
 * stray `</del>` that follows matches nothing and is dropped. The deleted text
 * on the far side of the boundary therefore carries no mark at all, so the
 * accept path has nothing to strip and keeps it: old and new text, concatenated.
 *
 * The two block-boundary cases are fixed: a fence delimiter is no longer
 * marker-wrapped, so the fence survives and each mark opens and closes inside
 * one block. The placeholder leak is a separate, still-open defect and stays
 * marked `it.fails`, so it turns RED the moment someone fixes it.
 */

import { diffPartialText, fromMarkdown } from "@saas/projects/lib/diff-utils";
import { describe, expect, it } from "vitest";

const FENCE = "```";

/**
 * Every `<del>`/`<ins>` must open and close inside one block, or the parser
 * silently discards the mark and the deletion becomes permanent content.
 */
function marksAreBlockBalanced(html: string): boolean {
	const blocks = html.split(/<\/p>|<pre[^>]*>|<\/pre>/);
	return blocks.every((block) => {
		const opens = (block.match(/<del\b|<ins\b/g) ?? []).length;
		const closes = (block.match(/<\/del>|<\/ins>/g) ?? []).length;
		return opens === closes;
	});
}

describe("deletion spanning a fence boundary", () => {
	it("keeps the mark inside one block when prose and the opener go", () => {
		const oldDoc = [
			"Intro prose.",
			"",
			`${FENCE}ts`,
			"a;",
			"b;",
			FENCE,
		].join("\n");
		const newDoc = ["a;", "b;", FENCE].join("\n");

		const html = fromMarkdown(diffPartialText(oldDoc, newDoc, true));

		expect(marksAreBlockBalanced(html)).toBe(true);
	});

	it("keeps the mark inside one block when the tail and closer go", () => {
		const oldDoc = [
			`${FENCE}ts`,
			"a;",
			"b;",
			FENCE,
			"",
			"Trailing prose.",
		].join("\n");
		const newDoc = [`${FENCE}ts`, "a;"].join("\n");

		const html = fromMarkdown(diffPartialText(oldDoc, newDoc, true));

		expect(marksAreBlockBalanced(html)).toBe(true);
	});

	it.fails("does not leak the internal fence placeholder into output", () => {
		const oldDoc = [
			`${FENCE}ts`,
			"a;",
			FENCE,
			"",
			`${FENCE}ts`,
			"b;",
			FENCE,
		].join("\n");
		const newDoc = [`${FENCE}ts`, "a;", "b;", FENCE].join("\n");

		const html = fromMarkdown(diffPartialText(oldDoc, newDoc, true));

		// Today the placeholder is rendered literally inside the code block.
		expect(html).not.toContain("DIFF_FENCE_");
	});
});

describe("deletion contained in one block (already fixed — guards the fix above)", () => {
	it("marks prose and in-fence deletions separately and closes both", () => {
		// Whoever fixes the cases above must not reach for atomising every
		// fence: that would drop word-level marking back to whole-block
		// replacement. This is the behaviour that must survive.
		const oldDoc = [
			"Remove this sentence.",
			"",
			`${FENCE}ts`,
			"const timeout = 30;",
			"const retries = 5;",
			FENCE,
		].join("\n");
		const newDoc = [`${FENCE}ts`, "const retries = 5;", FENCE].join("\n");

		const html = fromMarkdown(diffPartialText(oldDoc, newDoc, true));

		expect(marksAreBlockBalanced(html)).toBe(true);
		// Word-level, inside the code block — not a whole-fence swap.
		expect(html).toContain("<pre><code");
		expect(html).toMatch(/<pre><code[^>]*>[\s\S]*<del class="diff-del">/);
	});
});
