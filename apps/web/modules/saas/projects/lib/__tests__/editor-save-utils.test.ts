/**
 * Tests for editor-save-utils functions
 *
 * These tests verify the content transformation pipeline that prepares
 * editor HTML for saving to the database.
 *
 * Contract: `stripDiffTags` only touches class-marked diff tags —
 * `<ins class="diff-ins">` and `<del class="diff-del">` — which are the
 * exact forms emitted by `fromMarkdown` for AI diff regions. Bare
 * `<ins>` / `<del>` (from pasted HTML, Google Docs, GitHub rendered
 * markdown, etc.) are preserved as normal user content so they round-trip
 * correctly through the save path.
 */

import TurndownService from "turndown";
import { describe, expect, it } from "vitest";
import { disableEmphasisEscape, stripDiffTags } from "../editor-save-utils";

describe("stripDiffTags", () => {
	describe("class-marked diff additions", () => {
		it('unwraps <ins class="diff-ins"> but keeps content', () => {
			const html =
				'This is <ins class="diff-ins">new content</ins> in the text.';
			const result = stripDiffTags(html);

			expect(result).toBe("This is new content in the text.");
		});

		it("handles multiple diff-ins runs", () => {
			const html =
				'<ins class="diff-ins">First</ins> and <ins class="diff-ins">second</ins> additions.';
			const result = stripDiffTags(html);

			expect(result).toBe("First and second additions.");
		});

		it("handles diff-ins with extra classes", () => {
			const html =
				'This is <ins class="diff-ins highlight">styled</ins> content.';
			const result = stripDiffTags(html);

			expect(result).toBe("This is styled content.");
		});
	});

	describe("class-marked diff deletions", () => {
		it('removes <del class="diff-del"> AND its content', () => {
			const html =
				'This is <del class="diff-del">deleted content</del> in the text.';
			const result = stripDiffTags(html);

			expect(result).toBe("This is  in the text.");
		});

		it("handles multiple diff-del runs", () => {
			const html =
				'<del class="diff-del">Old</del> and <del class="diff-del">removed</del> text.';
			const result = stripDiffTags(html);

			expect(result).toBe(" and  text.");
		});

		it("handles nested content inside diff-del", () => {
			const html =
				'Keep <del class="diff-del">this <strong>bold</strong> text</del> gone.';
			const result = stripDiffTags(html);

			expect(result).toBe("Keep  gone.");
		});
	});

	describe("pasted bare <ins>/<del> must be preserved", () => {
		// Regression: before the class-gated contract, bare <ins>/<del> from
		// pasted HTML was indistinguishable from AI diff regions and got
		// eaten by stripDiffTags. Now they must round-trip as user content.

		it("leaves bare <ins> untouched", () => {
			const html = "This is <ins>pasted insert</ins> content.";
			const result = stripDiffTags(html);

			expect(result).toBe(html);
		});

		it("leaves bare <del> untouched (its content survives)", () => {
			const html = "Keep <del>pasted strike</del> this.";
			const result = stripDiffTags(html);

			expect(result).toBe(html);
		});

		it("leaves <ins> with an unrelated class untouched", () => {
			const html =
				'This is <ins class="highlight">emphasized</ins> text.';
			const result = stripDiffTags(html);

			expect(result).toBe(html);
		});

		it("strips diff-marked and preserves bare in the same string", () => {
			const html =
				'Kept <del>pasted strike</del> removed <del class="diff-del">ai deletion</del> done.';
			const result = stripDiffTags(html);

			expect(result).toContain("<del>pasted strike</del>");
			expect(result).not.toContain("ai deletion");
			expect(result).not.toMatch(/<del class="diff-del">/);
		});
	});

	describe("table additions (diff-table-added wrapper)", () => {
		it("unwraps added tables - removes div but keeps table", () => {
			const html = `<p>Text before</p>
<div class="diff-table-added"><table><tr><th>Header</th></tr><tr><td>Data</td></tr></table></div>
<p>Text after</p>`;
			const result = stripDiffTags(html);

			expect(result).toContain("<table>");
			expect(result).toContain("<th>Header</th>");
			expect(result).toContain("<td>Data</td>");
			expect(result).toContain("</table>");
			expect(result).not.toContain("diff-table-added");
		});

		it("handles double quotes in class attribute", () => {
			const html =
				'<div class="diff-table-added"><table><tr><td>Cell</td></tr></table></div>';
			const result = stripDiffTags(html);

			expect(result).toContain("<table>");
			expect(result).not.toContain("diff-table-added");
		});

		it("handles single quotes in class attribute", () => {
			const html =
				"<div class='diff-table-added'><table><tr><td>Cell</td></tr></table></div>";
			const result = stripDiffTags(html);

			expect(result).toContain("<table>");
			expect(result).not.toContain("diff-table-added");
		});
	});

	describe("table deletions (diff-table-deleted wrapper)", () => {
		it("removes deleted tables entirely - div AND content", () => {
			const html = `<p>Text before</p>
<div class="diff-table-deleted"><table><tr><th>Old Header</th></tr><tr><td>Old Data</td></tr></table></div>
<p>Text after</p>`;
			const result = stripDiffTags(html);

			expect(result).toContain("<p>Text before</p>");
			expect(result).toContain("<p>Text after</p>");
			expect(result).not.toContain("<table>");
			expect(result).not.toContain("Old Header");
			expect(result).not.toContain("Old Data");
			expect(result).not.toContain("diff-table-deleted");
		});

		it("handles double quotes in class attribute", () => {
			const html =
				'<div class="diff-table-deleted"><table><tr><td>Gone</td></tr></table></div>';
			const result = stripDiffTags(html);

			expect(result).not.toContain("Gone");
			expect(result).not.toContain("<table>");
		});

		it("handles single quotes in class attribute", () => {
			const html =
				"<div class='diff-table-deleted'><table><tr><td>Gone</td></tr></table></div>";
			const result = stripDiffTags(html);

			expect(result).not.toContain("Gone");
			expect(result).not.toContain("<table>");
		});
	});

	describe("mixed content", () => {
		it("handles diff additions and deletions together", () => {
			const html =
				'Keep <ins class="diff-ins">new</ins> text, remove <del class="diff-del">old</del> text.';
			const result = stripDiffTags(html);

			expect(result).toBe("Keep new text, remove  text.");
		});

		it("handles tables and inline diff together", () => {
			const html = `<h1><ins class="diff-ins">New Title</ins></h1>
<div class="diff-table-added"><table><tr><td>New Data</td></tr></table></div>
<p><del class="diff-del">Old paragraph</del></p>
<div class="diff-table-deleted"><table><tr><td>Old Table</td></tr></table></div>`;
			const result = stripDiffTags(html);

			// New title content kept
			expect(result).toContain("New Title");
			expect(result).not.toContain("<ins");

			// New table kept
			expect(result).toContain("New Data");
			expect(result).not.toContain("diff-table-added");

			// Old paragraph removed
			expect(result).not.toContain("Old paragraph");

			// Old table removed entirely
			expect(result).not.toContain("Old Table");
			expect(result).not.toContain("diff-table-deleted");
		});

		it("handles a complex document with multiple elements", () => {
			const html = `
<h1><ins class="diff-ins">Updated Heading</ins></h1>
<p>Some <ins class="diff-ins">new</ins> and <del class="diff-del">deleted</del> text.</p>
<div class="diff-table-added">
<table>
<tr><th>Feature</th><th>Status</th></tr>
<tr><td>Login</td><td>Done</td></tr>
</table>
</div>
<p>Final paragraph.</p>`;
			const result = stripDiffTags(html);

			expect(result).toContain("Updated Heading");
			expect(result).toContain("Some new and");
			expect(result).not.toContain("deleted");
			expect(result).toContain("<table>");
			expect(result).toContain("Feature");
			expect(result).toContain("Login");
			expect(result).toContain("Final paragraph.");
		});

		it("preserves user-authored italic, strikethrough, and pasted <ins>/<del>", () => {
			const html =
				'<p><em>Important note</em> and <s>completed task</s> with pasted <ins>highlight</ins>, pasted <del>strike</del>, diff <ins class="diff-ins">new text</ins>, and diff <del class="diff-del">old text</del>.</p>';
			const result = stripDiffTags(html);

			// User formatting preserved
			expect(result).toContain("<em>Important note</em>");
			expect(result).toContain("<s>completed task</s>");
			// Pasted bare <ins>/<del> preserved as-is
			expect(result).toContain("<ins>highlight</ins>");
			expect(result).toContain("<del>strike</del>");
			// Class-marked diff marks handled
			expect(result).toContain("new text");
			expect(result).not.toContain('class="diff-ins"');
			expect(result).not.toContain("old text");
			expect(result).not.toContain('class="diff-del"');
		});
	});

	describe("edge cases", () => {
		it("handles empty input", () => {
			expect(stripDiffTags("")).toBe("");
		});

		it("handles undefined input", () => {
			expect(stripDiffTags(undefined as unknown as string)).toBe("");
		});

		it("handles null input", () => {
			expect(stripDiffTags(null as unknown as string)).toBe("");
		});

		it("handles content without any diff tags", () => {
			const html =
				"<p>Regular content</p><table><tr><td>Data</td></tr></table>";
			const result = stripDiffTags(html);

			expect(result).toBe(html);
		});

		it("handles whitespace in tag attributes", () => {
			const html =
				'<div   class="diff-table-added"  ><table><tr><td>X</td></tr></table></div>';
			const result = stripDiffTags(html);

			expect(result).toContain("<table>");
			expect(result).not.toContain("diff-table-added");
		});
	});

	// A highlight split by an accepted AI diff leaves `</mark><mark …>`, the
	// same shape `<strong>`/`<em>`/`<s>`/`<u>` get. The attribute-free rule that
	// serves those is wrong for `<mark>` in BOTH directions, because
	// `Highlight.configure({ multicolor: true })` puts `data-color` (plus a
	// style attribute) on every toolbar highlight. The predicate is therefore
	// byte-equality of the two adjacent OPEN tags.
	describe("adjacent <mark> merging", () => {
		it("a self-closing <mark/> is never pushed onto the open-tag stack", () => {
			// A self-closing tag has no matching `</mark>`. If it were stacked, it
			// would leave a phantom entry that the NEXT real closing tag would pop,
			// mis-pairing every subsequent merge. The two real coloured marks must
			// still merge, and the self-closing tag must survive untouched.
			const html =
				'<p><mark/><mark data-color="#a">A</mark><mark data-color="#a">B</mark></p>';
			const result = stripDiffTags(html);
			expect(result).toContain("<mark/>");
			expect(result).toContain('<mark data-color="#a">AB</mark>');
		});

		it("merges two marks whose open tags are byte-identical", () => {
			const html =
				'<p><mark data-color="#a">A</mark><mark data-color="#a">B</mark></p>';
			const result = stripDiffTags(html);

			expect(result).toBe('<p><mark data-color="#a">AB</mark></p>');
		});

		it("merges a split highlight carrying both data-color and style", () => {
			// The exact tag TipTap emits for a toolbar highlight.
			const open =
				'<mark data-color="#ffd54f" style="background-color: #ffd54f; color: inherit">';
			const html = `<p><ins class="diff-ins">${open}Ship</mark></ins>${open} it</mark></p>`;
			const result = stripDiffTags(html);

			expect(result).toBe(`<p>${open}Ship it</mark></p>`);
		});

		it("does NOT merge a coloured mark into a bare one (would recolour it)", () => {
			const html = '<p><mark data-color="#a">A</mark><mark>B</mark></p>';

			expect(stripDiffTags(html)).toBe(html);
		});

		it("does NOT merge a bare mark into a coloured one", () => {
			const html = '<p><mark>A</mark><mark data-color="#a">B</mark></p>';

			expect(stripDiffTags(html)).toBe(html);
		});

		it("does NOT merge two marks of different colours", () => {
			const html =
				'<p><mark data-color="#a">A</mark><mark data-color="#b">B</mark></p>';

			expect(stripDiffTags(html)).toBe(html);
		});

		it("merges two adjacent bare marks", () => {
			const html = "<p><mark>A</mark><mark>B</mark></p>";

			expect(stripDiffTags(html)).toBe("<p><mark>AB</mark></p>");
		});

		it("collapses a chain of identical marks in the single pass", () => {
			const html =
				'<p><mark data-color="#a">A</mark><mark data-color="#a">B</mark><mark data-color="#a">C</mark></p>';

			expect(stripDiffTags(html)).toBe(
				'<p><mark data-color="#a">ABC</mark></p>',
			);
		});

		it("does not merge marks separated by any text", () => {
			const html = "<p><mark>A</mark> <mark>B</mark></p>";

			expect(stripDiffTags(html)).toBe(html);
		});

		it("leaves <marker>-style tags and generic type parameters alone", () => {
			// `/<\/?mark[^>]*>/` would eat these; the word-delimiting lookahead
			// is what keeps them.
			const html =
				"<p>Map&lt;markerId, string&gt; and <marker>x</marker></p>";

			expect(stripDiffTags(html)).toBe(html);
		});

		it("leaves existing bold/italic/strike merge behaviour unchanged", () => {
			const html =
				'<p><ins class="diff-ins"><strong>A</strong></ins><strong>B</strong> <em>C</em><em>D</em> <s>E</s><s>F</s> <u>G</u><u>H</u></p>';
			const result = stripDiffTags(html);

			expect(result).toBe(
				"<p><strong>AB</strong> <em>CD</em> <s>EF</s> <u>GH</u></p>",
			);
		});

		it("leaves a document with no marks byte-identical", () => {
			const html =
				"<h1>Title</h1><p>Body with <strong>bold</strong>, <em>italic</em> and <code>code</code>.</p><table><tr><td>Cell</td></tr></table>";

			expect(stripDiffTags(html)).toBe(html);
		});

		// KTD1 / docs/solutions/security-issues/redos-in-preview-markdown-strip.md:
		// a ReDoS fixture must be ONE long line with no newlines, and must assert
		// a hard time budget. This runs on the client main thread on every save.
		it("stays linear on a single-line fixture of many adjacent marks", () => {
			const mergeable = '<mark data-color="#a">x</mark>'.repeat(20000);
			const refused =
				'<mark data-color="#a">x</mark><mark data-color="#b">x</mark>'.repeat(
					10000,
				);
			// Unterminated openers — the shape that makes a pair-matching regex
			// rescan from every opener.
			const unpaired = '<mark data-color="#a">x'.repeat(20000);

			for (const fixture of [mergeable, refused, unpaired]) {
				expect(fixture).not.toContain("\n");
				const started = performance.now();
				stripDiffTags(fixture);
				expect(performance.now() - started).toBeLessThan(200);
			}
		});
	});
});

/**
 * The escape override is deliberately kept for ordered markers: a paragraph
 * that genuinely starts with `38. ` must not silently become a list on the
 * next parse. When `38\\.` shows up in a saved spec the defect is upstream —
 * the item lost its list role before serialization — so fix that, not this.
 */
describe("disableEmphasisEscape", () => {
	const escapeOf = (input: string): string => {
		const service = new TurndownService();
		disableEmphasisEscape(service);
		return service.escape(input);
	};

	it("escapes a leading ordered-list marker in a paragraph text node", () => {
		expect(escapeOf("38. GIVEN a condition")).toBe(
			"38\\. GIVEN a condition",
		);
	});

	it("leaves emphasis markers unescaped", () => {
		expect(escapeOf("a *b* and _c_ here")).toBe("a *b* and _c_ here");
	});

	it("still escapes the other structural characters", () => {
		expect(escapeOf("# heading")).toBe("\\# heading");
		expect(escapeOf("- bullet")).toBe("\\- bullet");
		expect(escapeOf("> quote")).toBe("\\> quote");
		expect(escapeOf("[link]")).toBe("\\[link\\]");
		expect(escapeOf("`code`")).toBe("\\`code\\`");
	});
});
