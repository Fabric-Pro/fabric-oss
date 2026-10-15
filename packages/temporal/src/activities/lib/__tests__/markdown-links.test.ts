import { describe, expect, it } from "vitest";
import { filterInPrefixLinks } from "../../../lib/in-prefix-links";
import { extractMarkdownLinkDestinations } from "../markdown-links";

const PAGE = "https://example.com/docs/guide/intro";

function links(markdown: string, pageUrl = PAGE): string[] {
	return extractMarkdownLinkDestinations(markdown, pageUrl);
}

describe("extractMarkdownLinkDestinations", () => {
	it("resolves root-relative, same-directory and parent-relative links", () => {
		expect(links("[A](/docs/a) [B](./b) [C](../c) [D](d)")).toEqual([
			"https://example.com/docs/a",
			"https://example.com/docs/guide/b",
			"https://example.com/docs/c",
			"https://example.com/docs/guide/d",
		]);
	});

	it("resolves a nested page's links against that page, not the crawl root", () => {
		expect(
			links("[Sib](sibling)", "https://example.com/docs/guide/deep/page"),
		).toEqual(["https://example.com/docs/guide/deep/sibling"]);
		expect(links("[Sib](sibling)", "https://example.com/docs/")).toEqual([
			"https://example.com/docs/sibling",
		]);
	});

	it("takes the destination of a link with a title, not the title", () => {
		expect(
			links(
				"[a](/docs/x \"Title\") [b](/docs/y 'single') [c](/docs/z (paren))",
			),
		).toEqual([
			"https://example.com/docs/x",
			"https://example.com/docs/y",
			"https://example.com/docs/z",
		]);
	});

	it("does not read a link written inside a link title", () => {
		expect(links('[A](next "Example [B](/docs/b)")')).toEqual([
			"https://example.com/docs/guide/next",
		]);
	});

	it("reads <…> destinations, inline and in reference definitions", () => {
		expect(
			links(
				'[a](</docs/with space>) [b][ref]\n\n[ref]: </docs/ref target> "T"',
			),
		).toEqual([
			"https://example.com/docs/with%20space",
			"https://example.com/docs/ref%20target",
		]);
	});

	it("unescapes backslash-escaped characters in destinations", () => {
		expect(links("[a](/docs/a\\(1\\)) [b](/docs/b\\_c)")).toEqual([
			"https://example.com/docs/a(1)",
			"https://example.com/docs/b_c",
		]);
	});

	it("keeps balanced parentheses in a destination", () => {
		expect(links("[t](/docs/topic(v2)/intro) and more)")).toEqual([
			"https://example.com/docs/topic(v2)/intro",
		]);
	});

	it("reads reference definitions in document order", () => {
		expect(
			links(
				"See [one][1] and [two].\n\n[1]: /docs/one\n[two]: https://example.com/docs/two 'Two'",
			),
		).toEqual([
			"https://example.com/docs/one",
			"https://example.com/docs/two",
		]);
	});

	it("reads GFM autolink literals and CommonMark autolinks", () => {
		expect(
			links(
				"Visit https://example.com/docs/lit or www.example.com/docs/www or <https://example.com/docs/angle>.",
			),
		).toEqual([
			"https://example.com/docs/lit",
			"http://www.example.com/docs/www",
			"https://example.com/docs/angle",
		]);
	});

	it("gives a bare www. literal the page's scheme when it names the page's host", () => {
		const page = "https://www.example.com/docs/intro";
		const found = links(
			"See www.example.com/docs/a, WWW.example.com/docs/b and www.other.example/docs/c.",
			page,
		);
		expect(found).toEqual([
			"https://www.example.com/docs/a",
			"https://www.example.com/docs/b",
			"http://www.other.example/docs/c",
		]);
		expect(filterInPrefixLinks(found, page, ["/docs"])).toEqual([
			"https://www.example.com/docs/a",
			"https://www.example.com/docs/b",
		]);
	});

	it("detects a www. literal after CRLF line endings and inside nested blocks", () => {
		expect(
			links(
				"# Docs\r\n\r\n> - see **www.example.com/docs/a**\r\n> - and _www.example.com/docs/b_\r\n",
				"https://www.example.com/docs/intro",
			),
		).toEqual([
			"https://www.example.com/docs/a",
			"https://www.example.com/docs/b",
		]);
	});

	it("keeps an explicitly written http: scheme on the page's host", () => {
		expect(
			links(
				"http://www.example.com/docs/a [www.example.com/docs/b](http://www.example.com/docs/b) <http://www.example.com/docs/c>",
				"https://www.example.com/docs/intro",
			),
		).toEqual([
			"http://www.example.com/docs/a",
			"http://www.example.com/docs/b",
			"http://www.example.com/docs/c",
		]);
	});

	it("ignores links inside inline code, fenced code, indented code and raw HTML", () => {
		const markdown = [
			"Real: [ok](/docs/ok)",
			"",
			"Inline `[no](/docs/inline)` and `https://example.com/docs/inline-bare`.",
			"",
			"```md",
			"[no](/docs/fenced)",
			"https://example.com/docs/fenced-bare",
			"```",
			"",
			"    [no](/docs/indented)",
			"",
			'<div><a href="/docs/html">x</a> [no](/docs/html-md)</div>',
		].join("\n");
		expect(links(markdown)).toEqual(["https://example.com/docs/ok"]);
	});

	it("skips images", () => {
		expect(links("![logo](/img/logo.png) [a](/docs/a)")).toEqual([
			"https://example.com/docs/a",
		]);
	});

	it("skips reference definitions that only images use, keeping ones a link also uses", () => {
		const markdown = [
			"![logo][image] [Guide][guide] ![shared][both] [Shared][both]",
			"",
			"[image]: /docs/logo.png",
			"[guide]: /docs/guide",
			"[both]: /docs/both",
			"[unused]: /docs/unused",
		].join("\n");
		expect(links(markdown)).toEqual([
			"https://example.com/docs/guide",
			"https://example.com/docs/both",
			"https://example.com/docs/unused",
		]);
	});

	it("excludes mailto, tel, javascript and fragment-only destinations", () => {
		expect(
			links(
				"[m](mailto:dev@example.com) <dev@example.com> [t](tel:+15555550100) [j](javascript:void(0)) [f](#section) [e]()",
			),
		).toEqual([]);
	});

	it("strips fragments and dedupes in document order", () => {
		expect(
			links(
				"[b](/docs/b#one) [a](/docs/a) [b2](/docs/b#two) [a2](https://example.com/docs/a)",
			),
		).toEqual(["https://example.com/docs/b", "https://example.com/docs/a"]);
	});

	it("keeps other-origin links (origin filtering is the caller's)", () => {
		expect(links("[x](https://other.example.com/docs/x)")).toEqual([
			"https://other.example.com/docs/x",
		]);
	});

	it("returns nothing when the page URL is not absolute", () => {
		expect(links("[a](/docs/a)", "not a url")).toEqual([]);
	});
});
