import { describe, expect, it } from "vitest";
import { convertConfluenceXhtmlToMarkdown } from "../confluence-storage-markdown";

describe("convertConfluenceXhtmlToMarkdown", () => {
	it("converts basic Confluence XHTML tags into markdown", () => {
		const xhtml =
			'<h1>Title</h1><p>Paragraph with <strong>bold</strong>, <em>italic</em>, and <code>code</code>.</p><ul><li>Item 1</li><li>Item 2</li></ul><a href="https://example.com">Example Link</a>';
		const md = convertConfluenceXhtmlToMarkdown(xhtml);
		expect(md).toContain("# Title");
		expect(md).toContain("Paragraph with **bold**, *italic*, and `code`.");
		expect(md).toContain("- Item 1\n- Item 2");
		expect(md).toContain("[Example Link](https://example.com)");
	});

	it("converts links with attributes and preserves link text", () => {
		const xhtml =
			'<a class="confluence-link" href="https://example.com/page">Page Title</a>';
		expect(convertConfluenceXhtmlToMarkdown(xhtml)).toBe(
			"[Page Title](https://example.com/page)",
		);
	});

	it("strips anchor tags without href while preserving text", () => {
		const xhtml = '<a name="anchor-section">Anchor Section</a>';
		expect(convertConfluenceXhtmlToMarkdown(xhtml)).toBe("Anchor Section");
	});

	it("preserves code block text inside CDATA blocks including angle brackets", () => {
		const xhtml =
			'<ac:structured-macro ac:name="code"><ac:plain-text-body><![CDATA[List<String> list = new ArrayList<>();]]></ac:plain-text-body></ac:structured-macro>';
		expect(convertConfluenceXhtmlToMarkdown(xhtml)).toBe(
			"List<String> list = new ArrayList<>();",
		);
	});

	it("preserves code block text with tag-like syntax without formatting conversion", () => {
		const xhtml =
			'<ac:structured-macro ac:name="code"><ac:plain-text-body><![CDATA[if (a <b && c> d)]]></ac:plain-text-body></ac:structured-macro>';
		expect(convertConfluenceXhtmlToMarkdown(xhtml)).toBe(
			"if (a <b && c> d)",
		);

		const xhtmlHtmlCode =
			'<ac:structured-macro ac:name="code"><ac:plain-text-body><![CDATA[<p>Hi</p> <strong>s</strong>]]></ac:plain-text-body></ac:structured-macro>';
		expect(convertConfluenceXhtmlToMarkdown(xhtmlHtmlCode)).toBe(
			"<p>Hi</p> <strong>s</strong>",
		);

		const xhtmlXmlCode =
			'<ac:structured-macro ac:name="code"><ac:plain-text-body><![CDATA[<project xmlns="http://maven.apache.org/POM/4.0.0">]]></ac:plain-text-body></ac:structured-macro>';
		expect(convertConfluenceXhtmlToMarkdown(xhtmlXmlCode)).toBe(
			'<project xmlns="http://maven.apache.org/POM/4.0.0">',
		);

		const xhtmlEntityCode =
			'<ac:structured-macro ac:name="code"><ac:plain-text-body><![CDATA[a &amp;&amp; b &lt; c]]></ac:plain-text-body></ac:structured-macro>';
		expect(convertConfluenceXhtmlToMarkdown(xhtmlEntityCode)).toBe(
			"a &amp;&amp; b &lt; c",
		);
	});

	it("avoids double-decoding entities so literal escaped entities remain escaped", () => {
		const xhtml = "<p>&amp;lt;not a tag&gt;</p>";
		expect(convertConfluenceXhtmlToMarkdown(xhtml)).toBe("&lt;not a tag>");
	});

	it("decodes HTML entities and normalizes whitespace", () => {
		const xhtml = "<p>A&nbsp;&amp;&nbsp;B&lt;C&gt;&quot;D&quot;</p>";
		expect(convertConfluenceXhtmlToMarkdown(xhtml)).toBe('A & B<C>"D"');
	});

	it("processes large pages with non-matching tags linearly without catastrophic backtracking", () => {
		// Adversarial input: 50,000 unclosed blockquote tags (~600 KB)
		const largeBlockquotes = "<blockquote>".repeat(50000);
		const start = performance.now();
		const result = convertConfluenceXhtmlToMarkdown(largeBlockquotes);
		const durationMs = performance.now() - start;

		expect(result).toBe("");
		expect(durationMs).toBeLessThan(500);
	});

	it.each([
		['unclosed link prefix `<a href="`', '<a href="', 120000],
		["bare angle brackets `<`", "<", 1000000],
		["unclosed tag prefix `<a `", "<a ", 300000],
		["unclosed tag prefix `<p `", "<p ", 300000],
		['repeated "xmlns"', "xmlns", 400000],
	])(
		"processes ~1 MB of %s linearly without catastrophic backtracking",
		(_name, pattern, repeatCount) => {
			const attackInput = pattern.repeat(repeatCount);
			const start = performance.now();
			convertConfluenceXhtmlToMarkdown(attackInput);
			const durationMs = performance.now() - start;

			expect(durationMs).toBeLessThan(500);
		},
	);
});
