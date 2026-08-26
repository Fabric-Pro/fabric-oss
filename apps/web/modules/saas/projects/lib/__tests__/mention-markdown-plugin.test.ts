import MarkdownIt from "markdown-it";
import { describe, expect, it } from "vitest";
import { mentionSpanInlinePlugin } from "../mention-markdown-plugin";

// The plugin's job is to claim mention spans as html_inline tokens.
// `createMarkdownIt()` in diff-utils.ts uses `html: true` because the diff
// renderer needs to pass <ins>/<del> through, so these tests use the same
// option to reflect production behavior.

describe("mentionSpanInlinePlugin (html: true — production config)", () => {
	it("passes through valid mention spans verbatim", () => {
		const md = new MarkdownIt({ html: true }).use(mentionSpanInlinePlugin);
		const out = md.render(
			'Hi <span data-type="mention" data-id="u1" data-mention-id="m_abc">@Alice</span>!',
		);
		expect(out).toContain(
			'<span data-type="mention" data-id="u1" data-mention-id="m_abc">@Alice</span>',
		);
	});

	it("accepts both single-quoted and double-quoted data-type", () => {
		const md = new MarkdownIt({ html: true }).use(mentionSpanInlinePlugin);
		const doubleQuoted = md.render(
			'<span data-type="mention" data-id="u1" data-mention-id="m_a">@A</span>',
		);
		const singleQuoted = md.render(
			"<span data-type='mention' data-id='u1' data-mention-id='m_a'>@A</span>",
		);
		expect(doubleQuoted).toContain('data-type="mention"');
		expect(singleQuoted).toContain("data-type='mention'");
	});

	it("preserves mention chip across full markdown round-trip", () => {
		// Realistic content: paragraph with mention chip in the middle of regular
		// markdown formatting.
		const md = new MarkdownIt({ html: true }).use(mentionSpanInlinePlugin);
		const input =
			'Hello **bold** and <span data-type="mention" data-id="u1" data-mention-id="m_xyz" class="mention">@Alice</span> _italic_!';
		const out = md.render(input);
		expect(out).toContain(
			'data-type="mention" data-id="u1" data-mention-id="m_xyz"',
		);
		expect(out).toContain("<strong>bold</strong>");
		expect(out).toContain("<em>italic</em>");
	});
});

describe("mentionSpanInlinePlugin (narrow-mode contract — html: false)", () => {
	// These tests document the plugin's behavior in a narrow-mode context where
	// only mention spans are permitted through inline HTML. createMarkdownIt()
	// does NOT use this configuration, but the plugin's contract is meaningful
	// here — it lets a future consumer wire the plugin into a strict markdown
	// instance with confidence that only mention spans pass through.

	it("passes through valid mention spans even with html: false", () => {
		const md = new MarkdownIt({ html: false }).use(mentionSpanInlinePlugin);
		const out = md.render(
			'<span data-type="mention" data-id="u1" data-mention-id="m_abc">@Alice</span>',
		);
		expect(out).toContain(
			'<span data-type="mention" data-id="u1" data-mention-id="m_abc">@Alice</span>',
		);
	});

	it("does NOT pass through spans without data-type='mention'", () => {
		const md = new MarkdownIt({ html: false }).use(mentionSpanInlinePlugin);
		const out = md.render(
			'<span class="injected" onclick="alert(1)">x</span>',
		);
		expect(out).not.toContain('<span class="injected"');
		expect(out).toContain("&lt;span");
	});

	it("does NOT pass through script tags", () => {
		const md = new MarkdownIt({ html: false }).use(mentionSpanInlinePlugin);
		const out = md.render("<script>alert(1)</script>");
		expect(out).not.toContain("<script>");
		expect(out).toContain("&lt;script");
	});

	it("bails on unclosed mention spans (safe failure)", () => {
		const md = new MarkdownIt({ html: false }).use(mentionSpanInlinePlugin);
		const out = md.render('<span data-type="mention" data-id="u1">@Alice');
		expect(out).toContain("&lt;span");
	});
});
