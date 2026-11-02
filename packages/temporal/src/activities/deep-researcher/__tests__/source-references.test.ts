import { describe, expect, it } from "vitest";
import { extractResearchSourceUrls } from "../source-references";

describe("extractResearchSourceUrls", () => {
	it("keeps Markdown destinations without adding titles or source prose", () => {
		const text = [
			"Source: **SQLite’s [WAL overview](https://sqlite.org/wal.html#overview). **Confidence: 100%.**",
			"According to [Concurrency](https://sqlite.org/wal.html#concurrency), readers retain a snapshot.",
			"Based on the conversation above.",
			"Referenced from an unverified heading.",
		].join("\n");
		expect(extractResearchSourceUrls(text)).toEqual([
			"https://sqlite.org/wal.html#overview",
			"https://sqlite.org/wal.html#concurrency",
		]);
	});

	it("deduplicates bare URLs in encounter order and preserves fragments", () => {
		expect(
			extractResearchSourceUrls(
				"Read https://example.com/guide#first, then https://example.com/guide#second. Again: https://example.com/guide#first.",
			),
		).toEqual([
			"https://example.com/guide#first",
			"https://example.com/guide#second",
		]);
	});

	it("uses Markdown parsing for balanced parentheses and surrounding punctuation", () => {
		expect(
			extractResearchSourceUrls(
				"[Reference](https://example.com/guide_(overview)#readers). Also (https://example.com/other_(page)); <https://example.com/final?x=1&y=2>.",
			),
		).toEqual([
			"https://example.com/guide_(overview)#readers",
			"https://example.com/other_(page)",
			"https://example.com/final?x=1&y=2",
		]);
	});

	it("keeps absolute HTTP reference definitions without treating relative or unsafe links as web sources", () => {
		expect(
			extractResearchSourceUrls(
				[
					"[Reference][official] [Relative](/docs) [Fragment](#readers)",
					"[Script](javascript:alert) [File](file:///example.txt) [FTP](ftp://example.com/file)",
					"[official]: http://example.com/reference#section",
				].join("\n\n"),
			),
		).toEqual(["http://example.com/reference#section"]);
	});

	it("does not count code, raw HTML, image URLs or link-title URLs as references", () => {
		expect(
			extractResearchSourceUrls(
				[
					"`https://example.com/inline`",
					"```\nhttps://example.com/code\n```",
					'<a href="https://example.com/html">HTML</a>',
					"![Image](https://example.com/image.png)",
					'[Good](https://example.com/reference "https://example.com/title")',
				].join("\n\n"),
			),
		).toEqual(["https://example.com/reference"]);
	});

	it("limits output to twenty distinct references", () => {
		const urls = Array.from(
			{ length: 25 },
			(_, index) => `https://example.com/reference/${index}`,
		);
		expect(extractResearchSourceUrls(urls.join("\n"))).toEqual(
			urls.slice(0, 20),
		);
	});
});
