/**
 * Unit tests for the story-sync-media transform helpers — pure functions
 * with no I/O (the one async helper, `resolveStoryMediaSignedUrls`, is
 * mocked via @repo/storage).
 *
 * Covers the bug spec for "Tables and Images in Fabric Feature Content Are
 * Not Synced to PM Tools": every transform that runs during a Fabric →
 * PM-tool push.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock @repo/storage so the async signed-URL resolver tests don't reach
// the real S3 client.
vi.mock("@repo/storage", () => ({
	getStorageProvider: vi.fn(() => ({
		getSignedUrl: vi.fn(
			async (key: string, _opts: { bucket: string; expiresIn: number }) =>
				`https://signed.example.com/${key}?Sig=abc&Expires=12345`,
		),
	})),
}));

// Mock @repo/config so we don't depend on real env-loaded config.
vi.mock("@repo/config", () => ({
	config: {
		storage: {
			bucketNames: {
				projectContexts: "test-project-contexts",
			},
		},
	},
}));

import {
	appendUnresolvedMediaNotice,
	cleanTiptapTableHtml,
	convertEmbeddedHtmlTablesToCleanHtml,
	convertEmbeddedHtmlTablesToMarkdown,
	convertMarkdownTablesToHtml,
	extractAdoTables,
	extractFizzyImages,
	extractImagesFromHtml,
	extractStoryMediaKeyFromUrl,
	extractStoryMediaKeysFromContent,
	fetchImageAsBase64DataUrl,
	htmlTableToMarkdownTable,
	imageToActionTextAttachment,
	imageToLexxyFigure,
	imageToMarkdown,
	inlineImagesAsBase64DataUrls,
	inlineJiraMarkdownImagesAsBase64DataUrls,
	looksFabricAuthored,
	parseImgTag,
	replaceHtmlImagesWithMarkdown,
	resolveFizzyAttachmentTarget,
	resolveFizzyImageEmbeds,
	resolveIssueSite,
	resolveJiraCloudTarget,
	resolveStoryMediaSignedUrls,
	restoreFizzyImages,
	restoreFizzyImagesWithEmbeds,
	rewriteFizzyInCellImagesHybrid,
	rewriteInCellImagesToBase64DataUrls,
	rewriteStoryMediaSourcesToSignedUrls,
	stripImagesForJira,
	uploadJiraImagesAndRewriteDescription,
} from "../story-sync-media";

// -----------------------------------------------------------------------------
// Key extraction
// -----------------------------------------------------------------------------

describe("extractStoryMediaKeyFromUrl", () => {
	it("matches a bare story-media/* key", () => {
		expect(extractStoryMediaKeyFromUrl("story-media/p1/s1/uuid.png")).toBe(
			"story-media/p1/s1/uuid.png",
		);
	});

	it("matches a root-relative path", () => {
		expect(extractStoryMediaKeyFromUrl("/story-media/p1/s1/uuid.png")).toBe(
			"story-media/p1/s1/uuid.png",
		);
	});

	it("strips the query string from a signed URL", () => {
		expect(
			extractStoryMediaKeyFromUrl(
				"https://bucket.host/story-media/p1/s1/uuid.png?Sig=abc&Expires=999",
			),
		).toBe("story-media/p1/s1/uuid.png");
	});

	it("ignores URLs without the prefix", () => {
		expect(
			extractStoryMediaKeyFromUrl("https://example.com/img/foo.png"),
		).toBeNull();
		expect(
			extractStoryMediaKeyFromUrl("document-media/foo.png"),
		).toBeNull();
	});

	it("returns null for empty input", () => {
		expect(extractStoryMediaKeyFromUrl("")).toBeNull();
	});
});

describe("extractStoryMediaKeysFromContent", () => {
	it("extracts keys from data-s3-key attributes", () => {
		const content =
			'<p>Hello <img src="x" data-s3-key="story-media/p/s/a.png"></p>';
		expect(extractStoryMediaKeysFromContent(content)).toEqual([
			"story-media/p/s/a.png",
		]);
	});

	it("extracts keys from <img> src attributes", () => {
		const content =
			'<img src="https://bucket.host/story-media/p/s/b.png?Sig=xx">';
		expect(extractStoryMediaKeysFromContent(content)).toEqual([
			"story-media/p/s/b.png",
		]);
	});

	it("extracts keys from markdown image syntax", () => {
		const content = "![Diagram](story-media/p/s/c.png)";
		expect(extractStoryMediaKeysFromContent(content)).toEqual([
			"story-media/p/s/c.png",
		]);
	});

	it("deduplicates the same key across multiple shapes", () => {
		const content = `
<img src="story-media/p/s/d.png" data-s3-key="story-media/p/s/d.png">
![alt](story-media/p/s/d.png)
		`;
		expect(extractStoryMediaKeysFromContent(content)).toEqual([
			"story-media/p/s/d.png",
		]);
	});

	it("returns multiple keys in first-seen order", () => {
		const content = `
<img data-s3-key="story-media/p/s/a.png">
![alt](story-media/p/s/b.png)
<img src="https://x/story-media/p/s/c.png?Sig=1">
		`;
		expect(extractStoryMediaKeysFromContent(content)).toEqual([
			"story-media/p/s/a.png",
			"story-media/p/s/b.png",
			"story-media/p/s/c.png",
		]);
	});

	it("ignores non-story-media URLs", () => {
		const content =
			'![nope](https://example.com/foo.png) <img src="https://other/document-media/d.png">';
		expect(extractStoryMediaKeysFromContent(content)).toEqual([]);
	});

	it("returns [] for empty content", () => {
		expect(extractStoryMediaKeysFromContent("")).toEqual([]);
	});
});

// -----------------------------------------------------------------------------
// Signed URL resolution
// -----------------------------------------------------------------------------

describe("resolveStoryMediaSignedUrls", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("returns an empty map for no keys", async () => {
		const map = await resolveStoryMediaSignedUrls([]);
		expect(map.size).toBe(0);
	});

	it("resolves keys to signed URLs in parallel", async () => {
		const map = await resolveStoryMediaSignedUrls([
			"story-media/p/s/a.png",
			"story-media/p/s/b.png",
		]);
		expect(map.size).toBe(2);
		expect(map.get("story-media/p/s/a.png")).toMatch(/^https:\/\/signed/);
		expect(map.get("story-media/p/s/b.png")).toMatch(/^https:\/\/signed/);
	});

	it("skips keys whose resolution fails (per-key isolation)", async () => {
		const { getStorageProvider } = await import("@repo/storage");
		vi.mocked(getStorageProvider).mockReturnValueOnce({
			getSignedUrl: vi.fn(async (key: string) => {
				if (key.endsWith("bad.png")) {
					throw new Error("S3 unreachable");
				}
				return `https://signed.example.com/${key}?Sig=ok`;
			}),
		} as unknown as ReturnType<typeof getStorageProvider>);

		const map = await resolveStoryMediaSignedUrls([
			"story-media/p/s/good.png",
			"story-media/p/s/bad.png",
		]);
		expect(map.size).toBe(1);
		expect(map.has("story-media/p/s/good.png")).toBe(true);
		expect(map.has("story-media/p/s/bad.png")).toBe(false);
	});
});

// -----------------------------------------------------------------------------
// Source rewriting
// -----------------------------------------------------------------------------

describe("rewriteStoryMediaSourcesToSignedUrls", () => {
	const signed = new Map<string, string>([
		[
			"story-media/p/s/a.png",
			"https://signed.example.com/story-media/p/s/a.png?Sig=abc",
		],
		[
			"story-media/p/s/b.png",
			"https://signed.example.com/story-media/p/s/b.png?Sig=def",
		],
	]);

	it("rewrites <img src> in HTML", () => {
		const input =
			'<p><img src="story-media/p/s/a.png" data-s3-key="story-media/p/s/a.png" alt="diagram"></p>';
		const { content, unresolvedKeys } =
			rewriteStoryMediaSourcesToSignedUrls(input, signed);
		expect(content).toContain(
			'src="https://signed.example.com/story-media/p/s/a.png?Sig=abc"',
		);
		// data-s3-key is preserved verbatim so the canonical key can still
		// be recovered on a later round-trip.
		expect(content).toContain('data-s3-key="story-media/p/s/a.png"');
		expect(unresolvedKeys).toEqual([]);
	});

	it("rewrites markdown image URLs", () => {
		const input = "![Diagram](story-media/p/s/b.png)";
		const { content } = rewriteStoryMediaSourcesToSignedUrls(input, signed);
		expect(content).toBe(
			"![Diagram](https://signed.example.com/story-media/p/s/b.png?Sig=def)",
		);
	});

	it("preserves markdown title syntax", () => {
		const input = '![alt](story-media/p/s/b.png "caption")';
		const { content } = rewriteStoryMediaSourcesToSignedUrls(input, signed);
		expect(content).toBe(
			'![alt](https://signed.example.com/story-media/p/s/b.png?Sig=def "caption")',
		);
	});

	it("reports unresolved keys without dropping them from the content", () => {
		const input =
			'<img src="story-media/p/s/missing.png" data-s3-key="story-media/p/s/missing.png">';
		const { content, unresolvedKeys } =
			rewriteStoryMediaSourcesToSignedUrls(input, signed);
		expect(content).toBe(input); // unchanged
		expect(unresolvedKeys).toEqual(["story-media/p/s/missing.png"]);
	});

	it("rewrites <img> with no src but a data-s3-key attribute", () => {
		const input = '<img data-s3-key="story-media/p/s/a.png" alt="x">';
		const { content } = rewriteStoryMediaSourcesToSignedUrls(input, signed);
		expect(content).toMatch(
			/<img src="https:\/\/signed\.example\.com\/story-media\/p\/s\/a\.png\?Sig=abc"/,
		);
	});

	it("is a no-op for content with no story-media references", () => {
		const input = "Just **bold** text and a [link](https://x.example).";
		const { content, unresolvedKeys } =
			rewriteStoryMediaSourcesToSignedUrls(input, signed);
		expect(content).toBe(input);
		expect(unresolvedKeys).toEqual([]);
	});

	it("rewrites an <a data-s3-key> href to the signed URL (pulled file link)", () => {
		const input =
			'<a href="https://stale.example/story-media/p/s/a.png?Sig=old" data-s3-key="story-media/p/s/a.png" download>report.pdf</a>';
		const { content, unresolvedKeys } =
			rewriteStoryMediaSourcesToSignedUrls(input, signed);
		expect(content).toContain(
			'href="https://signed.example.com/story-media/p/s/a.png?Sig=abc"',
		);
		expect(content).toContain('data-s3-key="story-media/p/s/a.png"');
		expect(content).toContain("report.pdf");
		expect(content).toContain("download");
		expect(unresolvedKeys).toEqual([]);
	});

	it("reports an unresolved file-link key without dropping it", () => {
		const input =
			'<a data-s3-key="story-media/p/s/missing.pdf" href="x">f.pdf</a>';
		const { content, unresolvedKeys } =
			rewriteStoryMediaSourcesToSignedUrls(input, signed);
		expect(content).toBe(input);
		expect(unresolvedKeys).toEqual(["story-media/p/s/missing.pdf"]);
	});
});

// -----------------------------------------------------------------------------
// Image extraction & rendering
// -----------------------------------------------------------------------------

describe("parseImgTag", () => {
	it("parses src, alt, and data-s3-key", () => {
		const tag =
			'<img src="https://x/story-media/p/s/a.png" alt="hello" data-s3-key="story-media/p/s/a.png" data-width="50%">';
		expect(parseImgTag(tag)).toEqual({
			src: "https://x/story-media/p/s/a.png",
			alt: "hello",
			s3Key: "story-media/p/s/a.png",
		});
	});

	it("falls back to extracting s3Key from src when data-s3-key is absent", () => {
		const tag = '<img src="https://x/story-media/p/s/b.png?Sig=1">';
		expect(parseImgTag(tag)).toEqual({
			src: "https://x/story-media/p/s/b.png?Sig=1",
			alt: "",
			s3Key: "story-media/p/s/b.png",
		});
	});

	it("returns s3Key=null for non-story-media images", () => {
		const tag = '<img src="https://example.com/foo.png" alt="ext">';
		expect(parseImgTag(tag)).toEqual({
			src: "https://example.com/foo.png",
			alt: "ext",
			s3Key: null,
		});
	});
});

describe("extractImagesFromHtml", () => {
	it("pulls every <img> tag out and returns them in order", () => {
		const input =
			'<p>before</p><img src="a.png"><p>mid</p><img src="b.png" alt="B"><p>after</p>';
		const { html, images } = extractImagesFromHtml(input);
		expect(html).toBe("<p>before</p><p>mid</p><p>after</p>");
		expect(images.map((i) => i.src)).toEqual(["a.png", "b.png"]);
		expect(images[1].alt).toBe("B");
	});

	it("handles self-closing img tags", () => {
		const input = '<img src="a.png" /><img src="b.png"/>';
		const { html, images } = extractImagesFromHtml(input);
		expect(html.trim()).toBe("");
		expect(images).toHaveLength(2);
	});
});

describe("imageToLexxyFigure", () => {
	it("emits a Lexxy attachment figure with src + alt", () => {
		expect(
			imageToLexxyFigure({
				src: "https://x/foo.png",
				alt: "Foo",
				s3Key: null,
			}),
		).toBe(
			'<figure class="lexxy-content__attachment-wrapper"><img src="https://x/foo.png" alt="Foo"></figure>',
		);
	});

	it("omits the alt attribute when alt is empty", () => {
		expect(imageToLexxyFigure({ src: "x.png", alt: "", s3Key: null })).toBe(
			'<figure class="lexxy-content__attachment-wrapper"><img src="x.png"></figure>',
		);
	});

	it("escapes double quotes in src/alt to prevent attribute injection", () => {
		expect(
			imageToLexxyFigure({
				src: 'x.png"><script>alert(1)</script>',
				alt: 'a"b',
				s3Key: null,
			}),
		).toBe(
			'<figure class="lexxy-content__attachment-wrapper"><img src="x.png&quot;><script>alert(1)</script>" alt="a&quot;b"></figure>',
		);
	});

	it("returns the empty string when src is missing", () => {
		expect(imageToLexxyFigure({ src: "", alt: "x", s3Key: null })).toBe("");
	});
});

describe("imageToMarkdown", () => {
	it("emits standard markdown image syntax", () => {
		expect(
			imageToMarkdown({
				src: "https://x/foo.png",
				alt: "Foo",
				s3Key: null,
			}),
		).toBe("![Foo](https://x/foo.png)");
	});

	it("strips brackets from alt to avoid breaking the markdown boundary", () => {
		expect(
			imageToMarkdown({ src: "x.png", alt: "a[b]c", s3Key: null }),
		).toBe("![abc](x.png)");
	});
});

describe("replaceHtmlImagesWithMarkdown", () => {
	it("converts a standalone <img> tag to a markdown image", () => {
		expect(
			replaceHtmlImagesWithMarkdown(
				'Before <img src="https://x/s.png" alt="Shot"> after',
			),
		).toBe("Before ![Shot](https://x/s.png) after");
	});

	it("converts multiple <img> tags and preserves surrounding markdown", () => {
		const input =
			'## Title\n\n<img src="a.png" alt="A">\n\nText **bold**\n\n<img src="b.png">';
		expect(replaceHtmlImagesWithMarkdown(input)).toBe(
			"## Title\n\n![A](a.png)\n\nText **bold**\n\n![](b.png)",
		);
	});

	it("drops an <img> with no src (matches imageToMarkdown)", () => {
		expect(replaceHtmlImagesWithMarkdown('x <img alt="no src"> y')).toBe(
			"x  y",
		);
	});

	it("leaves content with no <img> tags untouched", () => {
		const md = "# Heading\n\n| a | b |\n| --- | --- |\n| 1 | 2 |";
		expect(replaceHtmlImagesWithMarkdown(md)).toBe(md);
	});

	it("is self-closing-tag tolerant", () => {
		expect(
			replaceHtmlImagesWithMarkdown('<img src="c.png" alt="C" />'),
		).toBe("![C](c.png)");
	});
});

// -----------------------------------------------------------------------------
// HTML table → GFM markdown conversion
// -----------------------------------------------------------------------------

describe("htmlTableToMarkdownTable", () => {
	it("converts a simple table with header + body row", () => {
		const html =
			"<table><tbody><tr><th>Name</th><th>Owner</th></tr><tr><td>Auth</td><td>Vlad</td></tr></tbody></table>";
		expect(htmlTableToMarkdownTable(html)).toBe(
			["| Name | Owner |", "| --- | --- |", "| Auth | Vlad |"].join("\n"),
		);
	});

	it("strips Tiptap-specific attributes and classes", () => {
		const html =
			'<table class="tiptap-table" style="min-width: 75px;"><colgroup><col><col></colgroup><tbody><tr><th colspan="1" rowspan="1"><p>A</p></th><th colspan="1" rowspan="1"><p>B</p></th></tr><tr><td colspan="1" rowspan="1"><p>1</p></td><td colspan="1" rowspan="1"><p>2</p></td></tr></tbody></table>';
		const md = htmlTableToMarkdownTable(html);
		expect(md).toBe(["| A | B |", "| --- | --- |", "| 1 | 2 |"].join("\n"));
	});

	it("preserves inline formatting inside cells", () => {
		const html =
			'<table><tbody><tr><th>Field</th><th>Notes</th></tr><tr><td><p><strong>API</strong></p></td><td><p><em>important</em> and <a href="https://x">link</a></p></td></tr></tbody></table>';
		const md = htmlTableToMarkdownTable(html);
		expect(md).toContain("| **API** | *important* and [link](https://x) |");
	});

	it("preserves markdown image syntax for images inside cells", () => {
		const html =
			'<table><tbody><tr><th>Step</th><th>Screenshot</th></tr><tr><td>1</td><td><img src="https://signed/story-media/x.png" alt="step1"></td></tr></tbody></table>';
		const md = htmlTableToMarkdownTable(html);
		expect(md).toContain(
			"| 1 | ![step1](https://signed/story-media/x.png) |",
		);
	});

	it("escapes pipe characters inside cell text", () => {
		const html =
			"<table><tbody><tr><th>Op</th></tr><tr><td>a | b</td></tr></tbody></table>";
		expect(htmlTableToMarkdownTable(html)).toBe(
			["| Op |", "| --- |", "| a \\| b |"].join("\n"),
		);
	});

	it("synthesises an empty header row when no <th> is present", () => {
		const html =
			"<table><tbody><tr><td>1</td><td>2</td></tr><tr><td>3</td><td>4</td></tr></tbody></table>";
		const md = htmlTableToMarkdownTable(html);
		expect(md).toBe(
			["|   |   |", "| --- | --- |", "| 1 | 2 |", "| 3 | 4 |"].join("\n"),
		);
	});

	it("returns the empty string for an empty table", () => {
		expect(htmlTableToMarkdownTable("<table></table>")).toBe("");
		expect(htmlTableToMarkdownTable("<table><tbody></tbody></table>")).toBe(
			"",
		);
	});

	it("collapses internal whitespace inside cells to single spaces", () => {
		const html =
			"<table><tbody><tr><td>multi\n  line\n   content</td></tr></tbody></table>";
		const md = htmlTableToMarkdownTable(html);
		expect(md).toContain("multi line content");
	});

	it("decodes safe HTML entities in cell text", () => {
		const html =
			"<table><tbody><tr><td>a &amp; b &lt; c &gt; d</td></tr></tbody></table>";
		expect(htmlTableToMarkdownTable(html)).toContain("a & b < c > d");
	});

	it("pads ragged rows to the widest row's cell count", () => {
		const html =
			"<table><tbody><tr><th>A</th><th>B</th></tr><tr><td>1</td></tr></tbody></table>";
		const md = htmlTableToMarkdownTable(html);
		expect(md).toContain("| 1 |   |"); // second cell padded
	});

	// -------------------------------------------------------------------------
	// Cell formatting (regression fix): `<br>` and `<ul>` / `<li>` previously
	// got stripped by the catch-all tag-strip pass, mashing multi-line cells
	// into one word and dropping list bullets entirely.
	// -------------------------------------------------------------------------

	it("preserves `<br>` inline inside a cell instead of mashing the two halves together", () => {
		const html =
			"<table><tbody><tr><td>line1<br>line2</td></tr></tbody></table>";
		const md = htmlTableToMarkdownTable(html);
		expect(md).toContain("| line1<br>line2 |");
		// Sanity: the old behaviour produced `line1line2` — explicitly
		// guard against the regression.
		expect(md).not.toMatch(/line1line2/);
	});

	it("converts self-closing and variant `<br/>` forms", () => {
		const html =
			"<table><tbody><tr><td>a<br/>b<br />c<BR>d</td></tr></tbody></table>";
		const md = htmlTableToMarkdownTable(html);
		expect(md).toContain("| a<br>b<br>c<br>d |");
	});

	it("converts `<ul><li>` to bullet-prefixed `<br>`-separated cell content", () => {
		const html =
			"<table><tbody><tr><td><ul><li>first</li><li>second</li></ul></td></tr></tbody></table>";
		const md = htmlTableToMarkdownTable(html);
		// Leading `<br>` is trimmed so a list-only cell doesn't begin with
		// an empty line, but subsequent items are separated by `<br>`.
		expect(md).toContain("| • first<br>• second |");
	});

	it("converts `<ol>` ordered lists the same way as `<ul>`", () => {
		const html =
			"<table><tbody><tr><td><ol><li>alpha</li><li>beta</li></ol></td></tr></tbody></table>";
		const md = htmlTableToMarkdownTable(html);
		expect(md).toContain("| • alpha<br>• beta |");
	});

	it("preserves inline formatting inside list items", () => {
		const html =
			"<table><tbody><tr><td><ul><li><strong>bold</strong> step</li><li><em>italic</em> step</li></ul></td></tr></tbody></table>";
		const md = htmlTableToMarkdownTable(html);
		expect(md).toContain("• **bold** step");
		expect(md).toContain("• *italic* step");
	});

	it("handles mixed list and paragraph content in one cell", () => {
		const html =
			"<table><tbody><tr><td><p>intro</p><ul><li>x</li><li>y</li></ul></td></tr></tbody></table>";
		const md = htmlTableToMarkdownTable(html);
		// Intro paragraph + bulleted list, all on one line via `<br>` for
		// the list items.
		expect(md).toContain("| intro <br>• x<br>• y |");
	});

	it("does not begin a list-only cell with a stray `<br>`", () => {
		const html =
			"<table><tbody><tr><td><ul><li>only item</li></ul></td></tr></tbody></table>";
		const md = htmlTableToMarkdownTable(html);
		// The leading `<br>` from the list-item conversion is trimmed at
		// the end so the cell doesn't render with an empty first line.
		expect(md).toContain("| • only item |");
		expect(md).not.toMatch(/\|\s*<br>•/);
	});

	it("trims trailing `<br>` runs from cell content", () => {
		const html =
			"<table><tbody><tr><td>content<br><br></td></tr></tbody></table>";
		const md = htmlTableToMarkdownTable(html);
		expect(md).toContain("| content |");
		expect(md).not.toMatch(/content<br>/);
	});
});

// -----------------------------------------------------------------------------
// Clean-HTML table conversion (for ADO `System.Description` push). ADO's MCP
// server does not support a `format` hint on the update tool's JSON Patch
// entries, so the value must already be HTML.
// -----------------------------------------------------------------------------

describe("cleanTiptapTableHtml", () => {
	it("strips Tiptap class / style attributes from `<table>` and cells", () => {
		const html =
			'<table class="tiptap-table" style="min-width: 75px;"><tbody><tr><th class="x" style="color:red"><p>A</p></th></tr><tr><td class="y"><p>1</p></td></tr></tbody></table>';
		const out = cleanTiptapTableHtml(html);
		expect(out).not.toContain("class=");
		expect(out).not.toContain("style=");
		expect(out).toContain("<table>");
	});

	it("strips `<colgroup>` blocks", () => {
		const html =
			'<table><colgroup><col style="min-width:25px"><col style="min-width:25px"></colgroup><tbody><tr><th><p>A</p></th></tr></tbody></table>';
		const out = cleanTiptapTableHtml(html);
		expect(out).not.toContain("<colgroup");
		expect(out).not.toContain("<col ");
		expect(out).toContain("<table>");
	});

	it('strips default `colspan="1"` / `rowspan="1"` but keeps merged-cell values', () => {
		const html =
			'<table><tbody><tr><td colspan="1" rowspan="1">A</td><td colspan="2" rowspan="1">B</td></tr></tbody></table>';
		const out = cleanTiptapTableHtml(html);
		// Default 1s gone — they're noise.
		expect(out).not.toMatch(/colspan="1"/);
		expect(out).not.toMatch(/rowspan="1"/);
		// Real merge value preserved.
		expect(out).toContain('colspan="2"');
	});

	it("collapses `<p>` wrappers inside cells so the content stays inline", () => {
		const html =
			"<table><tbody><tr><th><p>Header</p></th></tr><tr><td><p>Body</p></td></tr></tbody></table>";
		const out = cleanTiptapTableHtml(html);
		expect(out).toContain("<th>Header</th>");
		expect(out).toContain("<td>Body</td>");
		expect(out).not.toContain("<p>");
	});

	it("preserves inline formatting (`<strong>`, `<em>`, `<a>`) inside cells", () => {
		const html =
			'<table><tbody><tr><td><p><strong>bold</strong> and <em>italic</em> <a href="https://x">link</a></p></td></tr></tbody></table>';
		const out = cleanTiptapTableHtml(html);
		expect(out).toContain("<strong>bold</strong>");
		expect(out).toContain("<em>italic</em>");
		expect(out).toContain('<a href="https://x">link</a>');
	});

	it("preserves `<img>` tags inside cells (ADO accepts inline images)", () => {
		const html =
			'<table><tbody><tr><td><p><img src="https://signed/story-media/p/s/x.png" alt="diagram"></p></td></tr></tbody></table>';
		const out = cleanTiptapTableHtml(html);
		expect(out).toContain(
			'<img src="https://signed/story-media/p/s/x.png" alt="diagram">',
		);
	});

	it("returns the empty string for a table with no `<tr>` rows", () => {
		expect(cleanTiptapTableHtml("<table></table>")).toBe("");
		expect(cleanTiptapTableHtml("<table><tbody></tbody></table>")).toBe("");
	});

	it("collapses multi-paragraph cell content to a single space-joined line", () => {
		const html =
			"<table><tbody><tr><td><p>first</p><p>second</p></td></tr></tbody></table>";
		const out = cleanTiptapTableHtml(html);
		// Both paragraph contents preserved as a single inline cell.
		expect(out).toContain("<td>first second</td>");
	});
});

describe("convertEmbeddedHtmlTablesToCleanHtml", () => {
	it("converts every embedded `<table>` block in a description to clean HTML", () => {
		const input =
			'# Heading\n\n<table class="tiptap-table"><colgroup><col></colgroup><tbody><tr><th colspan="1" rowspan="1"><p>A</p></th></tr><tr><td colspan="1" rowspan="1"><p>1</p></td></tr></tbody></table>\n\nText after.';
		const out = convertEmbeddedHtmlTablesToCleanHtml(input);
		// Surrounding text preserved.
		expect(out).toContain("# Heading");
		expect(out).toContain("Text after.");
		// Table cleaned but kept as HTML.
		expect(out).toContain("<table>");
		expect(out).toContain("<th>A</th>");
		expect(out).toContain("<td>1</td>");
		// Tiptap noise gone.
		expect(out).not.toContain("tiptap-table");
		expect(out).not.toContain("<colgroup");
		expect(out).not.toContain("colspan=");
		expect(out).not.toContain("rowspan=");
	});

	it("is a no-op for content with no `<table>` blocks", () => {
		const input = "Just text\n\n## Heading\n\n- bullet";
		expect(convertEmbeddedHtmlTablesToCleanHtml(input)).toBe(input);
	});

	it("drops empty tables", () => {
		const input = "Before.\n\n<table></table>\n\nAfter.";
		const out = convertEmbeddedHtmlTablesToCleanHtml(input);
		expect(out).toContain("Before.");
		expect(out).toContain("After.");
		expect(out).not.toContain("<table");
	});

	it("does NOT emit GFM markdown pipes (regression guard for the ADO update path)", () => {
		const html =
			'<table class="tiptap-table"><tbody><tr><th><p>A</p></th></tr><tr><td><p>1</p></td></tr></tbody></table>';
		const out = convertEmbeddedHtmlTablesToCleanHtml(html);
		expect(out).not.toContain("| A |");
		expect(out).not.toContain("| --- |");
	});

	it("converts a GFM markdown table to clean <table> HTML (ADO push of a typed table)", () => {
		const input =
			"Intro\n\n| 1 | 1 | 1 |\n| --- | --- | --- |\n| 1 | 1 | 1 |\n| 1 | 1 | 1 |\n\nOutro";
		const out = convertEmbeddedHtmlTablesToCleanHtml(input);
		expect(out).toContain("<table>");
		expect(out).toContain("<th>1</th>");
		expect(out).toContain("<td>1</td>");
		// The bug this fixes: ADO renders raw GFM pipes as literal text.
		expect(out).not.toContain("| 1 |");
		expect(out).not.toContain("| --- |");
		expect(out).toContain("Intro");
		expect(out).toContain("Outro");
	});
});

describe("convertMarkdownTablesToHtml", () => {
	it("converts a GFM table (header + separator + rows) to <table> HTML", () => {
		const out = convertMarkdownTablesToHtml(
			"| a | b |\n| --- | --- |\n| 1 | 2 |",
		);
		expect(out).toContain(
			"<table><thead><tr><th>a</th><th>b</th></tr></thead>",
		);
		expect(out).toContain("<tbody><tr><td>1</td><td>2</td></tr></tbody>");
		expect(out).toContain("</table>");
		expect(out).not.toContain("| --- |");
	});

	it("keeps surrounding text and lands the table as its own block", () => {
		const out = convertMarkdownTablesToHtml(
			"before\n\n| a |\n| --- |\n| 1 |\n\nafter",
		);
		expect(out).toMatch(/before\n\n<table>[\s\S]*<\/table>\n\nafter/);
	});

	it("HTML-escapes cell content", () => {
		const out = convertMarkdownTablesToHtml("| x |\n| --- |\n| a < b |");
		expect(out).toContain("<td>a &lt; b</td>");
	});

	it("is a byte-for-byte no-op when there is no table", () => {
		const input = "Just text with a | pipe but no table.";
		expect(convertMarkdownTablesToHtml(input)).toBe(input);
	});
});

describe("extractAdoTables — GFM markdown table normalisation (ADO push — WI #235)", () => {
	it("normalises a GFM markdown table to a cleaned <table> token", () => {
		const input =
			"Create Database\n\n| 1 | 1 | 1 |\n| --- | --- | --- |\n| 1 | 1 | 1 |\n| 1 | 1 | 1 |";
		const { withTokens, tables } = extractAdoTables(input);
		expect(tables).toHaveLength(1);
		// The cleaned table is HTML (renders in ADO), not literal GFM pipes.
		expect(tables[0]).toContain("<table>");
		expect(tables[0]).toContain("<td>1</td>");
		expect(tables[0]).not.toContain("| 1 |");
		// Token replaced the markdown; surrounding text kept; no pipes left.
		expect(withTokens).not.toContain("| 1 |");
		expect(withTokens).not.toContain("| --- |");
		expect(withTokens).toContain("Create Database");
	});

	it("still extracts an existing <table> HTML block (no GFM)", () => {
		const input = "<table><tbody><tr><td>A</td></tr></tbody></table>";
		const { tables } = extractAdoTables(input);
		expect(tables).toHaveLength(1);
		expect(tables[0]).toContain("<td>A</td>");
	});
});

describe("convertEmbeddedHtmlTablesToMarkdown", () => {
	it("converts every embedded <table> in a markdown description", () => {
		const input =
			"# Heading\n\nText before.\n\n<table><tbody><tr><th>A</th></tr><tr><td>1</td></tr></tbody></table>\n\nText after.";
		const out = convertEmbeddedHtmlTablesToMarkdown(input);
		expect(out).toContain("# Heading");
		expect(out).toContain("| A |\n| --- |\n| 1 |");
		expect(out).toContain("Text after.");
		expect(out).not.toContain("<table");
	});

	it("is a no-op for content with no <table> blocks", () => {
		const input = "Just text\n\n## Heading\n\n- bullet";
		expect(convertEmbeddedHtmlTablesToMarkdown(input)).toBe(input);
	});

	it("drops empty tables", () => {
		const input = "Before.\n\n<table></table>\n\nAfter.";
		const out = convertEmbeddedHtmlTablesToMarkdown(input);
		expect(out).toContain("Before.");
		expect(out).toContain("After.");
		expect(out).not.toContain("<table");
	});
});

// -----------------------------------------------------------------------------
// Fizzy image extract/restore pipeline
// -----------------------------------------------------------------------------

describe("extractFizzyImages / restoreFizzyImages", () => {
	it("extracts HTML <img> tags into the image list and tokens into the text", () => {
		const input =
			'<p>before</p>\n\n<img src="a.png" alt="A">\n\n<p>after</p>';
		const { withTokens, images } = extractFizzyImages(input);
		expect(withTokens).not.toContain("<img");
		expect(withTokens).toContain("__FIZZY_IMG_0__");
		expect(images).toHaveLength(1);
		expect(images[0].src).toBe("a.png");
		expect(images[0].alt).toBe("A");
	});

	it("extracts markdown ![alt](url) into the image list", () => {
		const input =
			"# H\n\n![first](x.png)\n\nMid\n\n![second](https://y/z.png)";
		const { withTokens, images } = extractFizzyImages(input);
		expect(withTokens).not.toContain("![");
		expect(withTokens).toContain("__FIZZY_IMG_0__");
		expect(withTokens).toContain("__FIZZY_IMG_1__");
		expect(images.map((i) => i.src)).toEqual(["x.png", "https://y/z.png"]);
	});

	it("restoreFizzyImages substitutes <p>token</p> with a Lexxy figure", () => {
		const html = "<p>before</p><p>__FIZZY_IMG_0__</p><p>after</p>";
		const out = restoreFizzyImages(html, [
			{ src: "a.png", alt: "A", s3Key: null },
		]);
		expect(out).toBe(
			'<p>before</p><figure class="lexxy-content__attachment-wrapper"><img src="a.png" alt="A"></figure><p>after</p>',
		);
	});

	it("restoreFizzyImages handles a bare token without <p> wrapper", () => {
		const html = "prefix __FIZZY_IMG_0__ suffix";
		const out = restoreFizzyImages(html, [
			{ src: "a.png", alt: "", s3Key: null },
		]);
		expect(out).toBe(
			'prefix <figure class="lexxy-content__attachment-wrapper"><img src="a.png"></figure> suffix',
		);
	});

	it("restoreFizzyImages is a no-op when there are no images", () => {
		expect(restoreFizzyImages("<p>x</p>", [])).toBe("<p>x</p>");
	});
});

// -----------------------------------------------------------------------------
// Heuristic — Fabric-authored detection
// -----------------------------------------------------------------------------

describe("looksFabricAuthored", () => {
	it("returns true for Tiptap class marker", () => {
		expect(
			looksFabricAuthored(
				'<table class="tiptap-table"><tr><td>x</td></tr></table>',
			),
		).toBe(true);
	});

	it("returns true for <colgroup> block", () => {
		expect(
			looksFabricAuthored(
				"<table><colgroup><col></colgroup><tr><td>x</td></tr></table>",
			),
		).toBe(true);
	});

	it("returns true for Tiptap default cell attrs", () => {
		expect(
			looksFabricAuthored('<tr><td colspan="1" rowspan="1">x</td></tr>'),
		).toBe(true);
	});

	it("returns true for story-media data-s3-key", () => {
		expect(
			looksFabricAuthored('<img data-s3-key="story-media/p/s/a.png">'),
		).toBe(true);
	});

	it("returns true for markdown image with story-media URL", () => {
		expect(looksFabricAuthored("![x](story-media/p/s/a.png)")).toBe(true);
	});

	// Regression #1471: plain Fabric markdown (AI-generated feature stubs, or any
	// text ticket without a table / uploaded image) must be recognised as
	// Fabric-authored so it gets converted to HTML on ADO push. Before this it
	// fell through to the verbatim path and shipped raw `##`/`**`/`-` to ADO.
	it("returns true for an AI-stub plain markdown description", () => {
		const stub = [
			"# Feature Stub: Untitled",
			"",
			"**Scope justification:** placeholder feature.",
			"",
			"## PM System Reference",
			"",
			"- System of record: TBD",
			"- Feature link / ID: TBD",
		].join("\n");
		expect(looksFabricAuthored(stub)).toBe(true);
	});

	it("returns true for a markdown heading", () => {
		expect(looksFabricAuthored("## Overview\n\nsome text")).toBe(true);
	});

	it("returns true for a markdown bullet list", () => {
		expect(looksFabricAuthored("- first\n- second")).toBe(true);
	});

	it("returns true for an ordered list", () => {
		expect(looksFabricAuthored("1. first\n2. second")).toBe(true);
	});

	it("returns true for markdown bold emphasis", () => {
		expect(looksFabricAuthored("This is **important** text.")).toBe(true);
	});

	it("returns true for a fenced code block", () => {
		expect(looksFabricAuthored("```ts\nconst x = 1;\n```")).toBe(true);
	});

	it("returns false for multi-line pulled HTML with list/strong markup", () => {
		// Guard: real pulled HTML uses <ul>/<li>/<strong>, never line-leading
		// markdown markers — must still be treated as NOT Fabric-authored so the
		// round-trip verbatim path is preserved (the #783 double-escape fix).
		const pulled = [
			"<p>Pulled from ADO</p>",
			"<ul><li>one</li><li>two</li></ul>",
			"<p><strong>bold</strong> text</p>",
		].join("\n");
		expect(looksFabricAuthored(pulled)).toBe(false);
	});

	it("returns false for pulled HTML from a PM tool", () => {
		expect(
			looksFabricAuthored(
				"<p>Description from ADO</p><table><tr><td>A</td></tr></table><p>back link</p>",
			),
		).toBe(false);
	});

	it("returns false for empty content", () => {
		expect(looksFabricAuthored("")).toBe(false);
	});
});

// -----------------------------------------------------------------------------
// Fallback notice
// -----------------------------------------------------------------------------

describe("appendUnresolvedMediaNotice", () => {
	it("is a no-op when no images are unresolved", () => {
		expect(appendUnresolvedMediaNotice("body", 0, "https://x")).toBe(
			"body",
		);
	});

	it("appends a singular notice with a Fabric link", () => {
		const out = appendUnresolvedMediaNotice(
			"body",
			1,
			"https://fabric.pro/app/x",
		);
		expect(out).toContain(
			"_Note: 1 image could not be embedded — view the original in [Fabric](https://fabric.pro/app/x)._",
		);
	});

	it("appends a plural notice with multiple images", () => {
		const out = appendUnresolvedMediaNotice(
			"body",
			3,
			"https://fabric.pro/app/x",
		);
		expect(out).toContain(
			"_Note: 3 images could not be embedded — view the original in [Fabric](https://fabric.pro/app/x)._",
		);
	});

	it("falls back to no link when fabricUrl is null", () => {
		const out = appendUnresolvedMediaNotice("body", 1, null);
		expect(out).toContain(
			"_Note: 1 image could not be embedded — view the original in Fabric._",
		);
	});
});

// =============================================================================
// Base64 inline (Fizzy image render fix)
// =============================================================================

describe("Base64 inline data URLs", () => {
	const fetchMock = vi.fn();
	beforeEach(() => {
		fetchMock.mockReset();
		// Replace global fetch for these tests
		vi.stubGlobal("fetch", fetchMock);
	});

	it("fetchImageAsBase64DataUrl returns a data: URL on success", async () => {
		const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]); // PNG signature
		fetchMock.mockResolvedValue({
			ok: true,
			status: 200,
			arrayBuffer: async () => bytes.buffer,
			headers: { get: () => "image/png" },
		});
		const out = await fetchImageAsBase64DataUrl(
			"https://example.com/x.png",
		);
		expect(out).toBe(
			`data:image/png;base64,${Buffer.from(bytes).toString("base64")}`,
		);
	});

	it("fetchImageAsBase64DataUrl trims charset/parameters off the content-type", async () => {
		fetchMock.mockResolvedValue({
			ok: true,
			status: 200,
			arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
			headers: { get: () => "image/jpeg; charset=binary" },
		});
		const out = await fetchImageAsBase64DataUrl(
			"https://example.com/x.jpg",
		);
		expect(out?.startsWith("data:image/jpeg;base64,")).toBe(true);
	});

	it("fetchImageAsBase64DataUrl returns null on non-OK response", async () => {
		fetchMock.mockResolvedValue({
			ok: false,
			status: 404,
			arrayBuffer: async () => new Uint8Array().buffer,
			headers: { get: () => null },
		});
		const out = await fetchImageAsBase64DataUrl(
			"https://example.com/missing.png",
		);
		expect(out).toBeNull();
	});

	it("fetchImageAsBase64DataUrl returns null on fetch throw", async () => {
		fetchMock.mockRejectedValue(new Error("offline"));
		const out = await fetchImageAsBase64DataUrl(
			"https://example.com/x.png",
		);
		expect(out).toBeNull();
	});

	it("fetchImageAsBase64DataUrl passes existing data: URLs through untouched", async () => {
		const dataUrl = "data:image/png;base64,iVBORw0KGgo=";
		const out = await fetchImageAsBase64DataUrl(dataUrl);
		expect(out).toBe(dataUrl);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("inlineImagesAsBase64DataUrls rewrites each src to a data: URL", async () => {
		fetchMock.mockResolvedValue({
			ok: true,
			status: 200,
			arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
			headers: { get: () => "image/png" },
		});
		const inlined = await inlineImagesAsBase64DataUrls([
			{ src: "https://a.example/1.png", alt: "a", s3Key: null },
			{ src: "https://b.example/2.png", alt: "b", s3Key: null },
		]);
		expect(inlined).toHaveLength(2);
		expect(inlined[0].src.startsWith("data:image/png;base64,")).toBe(true);
		expect(inlined[1].src.startsWith("data:image/png;base64,")).toBe(true);
		expect(inlined[0].alt).toBe("a");
	});

	it("inlineImagesAsBase64DataUrls leaves src in place when fetch fails", async () => {
		fetchMock.mockResolvedValue({
			ok: false,
			status: 502,
			arrayBuffer: async () => new Uint8Array().buffer,
			headers: { get: () => null },
		});
		const original = {
			src: "https://will-fail.example/x.png",
			alt: "x",
			s3Key: null,
		};
		const inlined = await inlineImagesAsBase64DataUrls([original]);
		expect(inlined[0].src).toBe(original.src);
	});

	it("rewriteInCellImagesToBase64DataUrls inlines <img> tags inside an HTML fragment", async () => {
		fetchMock.mockResolvedValue({
			ok: true,
			status: 200,
			arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
			headers: { get: () => "image/png" },
		});
		const html =
			'<td><p>before</p><img src="https://x.example/cell.png" alt="cell"></td>';
		const out = await rewriteInCellImagesToBase64DataUrls(html);
		expect(out).toMatch(/src="data:image\/png;base64,/);
		expect(out).not.toContain("https://x.example/cell.png");
		// Surrounding HTML preserved
		expect(out).toContain("<p>before</p>");
	});

	it("rewriteInCellImagesToBase64DataUrls leaves HTML untouched when there are no img tags", async () => {
		const html = "<td><p>just text, no images</p></td>";
		const out = await rewriteInCellImagesToBase64DataUrls(html);
		expect(out).toBe(html);
		expect(fetchMock).not.toHaveBeenCalled();
	});
});

// =============================================================================
// In-cell line-break separator (Jira cosmetic fix)
// =============================================================================

describe("htmlTableToMarkdownTable inCellLineBreakSeparator", () => {
	const tableWithCellList = [
		"<table>",
		"<tr><th>Area</th><th>Notes</th></tr>",
		"<tr><td>Project Brief</td><td><ul><li>Persists on save</li><li>Revert restored</li><li>No data loss</li></ul></td></tr>",
		"<tr><td>Navigation</td><td>Return to list works<br>No 404 page</td></tr>",
		"</table>",
	].join("");

	it("default emits <br> for in-cell line breaks (GitHub/GitLab/Linear/ADO)", () => {
		const md = htmlTableToMarkdownTable(tableWithCellList);
		expect(md).toContain(
			"| Project Brief | • Persists on save<br>• Revert restored<br>• No data loss |",
		);
		expect(md).toContain(
			"| Navigation | Return to list works<br>No 404 page |",
		);
	});

	it("inCellLineBreakSeparator: ' / ' replaces every <br> with ' / ' (Jira)", () => {
		const md = htmlTableToMarkdownTable(tableWithCellList, {
			inCellLineBreakSeparator: " / ",
		});
		expect(md).toContain(
			"| Project Brief | • Persists on save / • Revert restored / • No data loss |",
		);
		expect(md).toContain(
			"| Navigation | Return to list works / No 404 page |",
		);
		// No literal <br> survives in the output.
		expect(md).not.toMatch(/<br>/);
	});

	it("convertEmbeddedHtmlTablesToMarkdown forwards the cell options through", () => {
		const body = `## Issue\n\n${tableWithCellList}\n\nEnd.`;
		const out = convertEmbeddedHtmlTablesToMarkdown(body, {
			inCellLineBreakSeparator: " / ",
		});
		expect(out).toContain(
			"Persists on save / • Revert restored / • No data loss",
		);
		expect(out).not.toMatch(/<br>/);
	});
});

// =============================================================================
// Jira base64 inline (replaces deleted attachment-upload helpers from PR #1164)
// =============================================================================

describe("inlineJiraMarkdownImagesAsBase64DataUrls", () => {
	const fetchMock = vi.fn();
	beforeEach(() => {
		fetchMock.mockReset();
		vi.stubGlobal("fetch", fetchMock);
	});

	function mockSourceOk() {
		fetchMock.mockResolvedValue({
			ok: true,
			status: 200,
			arrayBuffer: async () =>
				new Uint8Array([0x89, 0x50, 0x4e, 0x47]).buffer,
			headers: { get: () => "image/png" },
		});
	}

	it("rewrites markdown ![](url) to a data: URL on success", async () => {
		mockSourceOk();
		const md =
			"## Attachments\n\n![Standalone](https://placehold.co/300x150.png)";
		const out = await inlineJiraMarkdownImagesAsBase64DataUrls(md);
		expect(out).toMatch(
			/!\[Standalone\]\(data:image\/png;base64,[A-Za-z0-9+/=]+\)/,
		);
		expect(out).not.toContain("https://placehold.co/300x150.png");
	});

	it('rewrites HTML <img src="url"> inside a cell to a data: URL', async () => {
		mockSourceOk();
		const md =
			'| Tech | Open | <img src="https://placehold.co/120x60.png" alt="cell"> |';
		const out = await inlineJiraMarkdownImagesAsBase64DataUrls(md);
		expect(out).toMatch(/src="data:image\/png;base64,[^"]+"/);
		expect(out).not.toContain("https://placehold.co/120x60.png");
	});

	it("dedupes repeated URLs to one fetch but rewrites every occurrence", async () => {
		mockSourceOk();
		const md =
			"![a](https://example.com/x.png) and again ![b](https://example.com/x.png)";
		const out = await inlineJiraMarkdownImagesAsBase64DataUrls(md);
		expect(out).not.toContain("https://example.com/x.png");
		const occurrences = (
			out.match(/data:image\/png;base64,[A-Za-z0-9+/=]+/g) ?? []
		).length;
		expect(occurrences).toBe(2);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("skips data: URLs already inlined", async () => {
		const md =
			"![](data:image/png;base64,iVBORw0KGgo=) plus ![](https://example.com/x.png)";
		fetchMock.mockResolvedValue({
			ok: true,
			status: 200,
			arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
			headers: { get: () => "image/png" },
		});
		const out = await inlineJiraMarkdownImagesAsBase64DataUrls(md);
		expect(out).toContain("data:image/png;base64,iVBORw0KGgo=");
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(out).not.toContain("https://example.com/x.png");
	});

	it("skips non-HTTP URLs (e.g. literal 'url' from broken backtick syntax)", async () => {
		const md = "![alt](url) and ![alt](mailto:nope)";
		const out = await inlineJiraMarkdownImagesAsBase64DataUrls(md);
		expect(out).toBe(md);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("leaves URL in place when fetch fails", async () => {
		fetchMock.mockResolvedValue({
			ok: false,
			status: 404,
			arrayBuffer: async () => new Uint8Array().buffer,
			headers: { get: () => null },
		});
		const md = "![](https://will-404.example/x.png)";
		const out = await inlineJiraMarkdownImagesAsBase64DataUrls(md);
		expect(out).toBe(md);
	});

	it("returns the input unchanged when there are no images", async () => {
		const md = "## Just text\n\nNo images here.";
		const out = await inlineJiraMarkdownImagesAsBase64DataUrls(md);
		expect(out).toBe(md);
		expect(fetchMock).not.toHaveBeenCalled();
	});
});

// =============================================================================
// Fizzy native ActionText attachment (PR #1168)
// =============================================================================

// Re-declare the `@repo/utils.decryptApiKey` mock now that the Jira-attachment
// helpers (and their original mock) were deleted in PR #1166. The Fizzy
// `resolveFizzyAttachmentTarget` uses the same decryptApiKey to unlock the
// per-user API key from `MCPConfig.encryptedApiKey`.
vi.mock("@repo/utils", () => ({
	decryptApiKey: vi.fn((encrypted: string) =>
		encrypted === "ENCRYPTED_GOOD"
			? "decrypted-bearer-token"
			: (() => {
					throw new Error(`unknown encrypted blob: ${encrypted}`);
				})(),
	),
}));

describe("resolveFizzyAttachmentTarget", () => {
	it("returns a target when API key + account_slug are present", async () => {
		const target = await resolveFizzyAttachmentTarget(
			{ encryptedApiKey: "ENCRYPTED_GOOD" },
			{ account_slug: "/000001" },
		);
		expect(target).toEqual({
			apiKey: "decrypted-bearer-token",
			accountSlug: "/000001",
		});
	});

	it("returns null when MCPConfig has no encryptedApiKey", async () => {
		const target = await resolveFizzyAttachmentTarget(
			{ encryptedApiKey: null },
			{ account_slug: "/000001" },
		);
		expect(target).toBeNull();
	});

	it("returns null when account_slug is missing", async () => {
		const target = await resolveFizzyAttachmentTarget(
			{ encryptedApiKey: "ENCRYPTED_GOOD" },
			{},
		);
		expect(target).toBeNull();
	});

	it("returns null when decrypt throws", async () => {
		const target = await resolveFizzyAttachmentTarget(
			{ encryptedApiKey: "ENCRYPTED_BAD" },
			{ account_slug: "/000001" },
		);
		expect(target).toBeNull();
	});
});

describe("imageToActionTextAttachment", () => {
	it("renders the canonical Rails ActionText tag", () => {
		expect(imageToActionTextAttachment("eyJfcmFpbHMi...abc")).toBe(
			'<action-text-attachment sgid="eyJfcmFpbHMi...abc"></action-text-attachment>',
		);
	});
	it("escapes double quotes in the sgid", () => {
		expect(imageToActionTextAttachment('with"quote')).toBe(
			'<action-text-attachment sgid="with&quot;quote"></action-text-attachment>',
		);
	});
});

describe("resolveFizzyImageEmbeds", () => {
	const fetchMock = vi.fn();
	beforeEach(() => {
		fetchMock.mockReset();
		vi.stubGlobal("fetch", fetchMock);
	});

	const target = {
		apiKey: "fake-bearer",
		accountSlug: "/000001",
	};

	/**
	 * Mock the 3-step direct_uploads flow. Sgid is derived from the filename
	 * in the POST body so it tracks deterministically per-image (Promise.all
	 * over multiple images runs in parallel — counter-based mocks race).
	 */
	function mockSuccessfulUpload() {
		fetchMock.mockImplementation((url: string, init?: RequestInit) => {
			if (!init || (init.method ?? "GET") === "GET") {
				return Promise.resolve({
					ok: true,
					status: 200,
					arrayBuffer: async () =>
						new Uint8Array([0x89, 0x50, 0x4e, 0x47]).buffer,
					headers: { get: () => "image/png" },
				});
			}
			if (init.method === "POST") {
				// direct_uploads — derive sgid from posted filename
				const body =
					typeof init.body === "string" ? JSON.parse(init.body) : {};
				const fileName = body?.blob?.filename ?? "unknown";
				return Promise.resolve({
					ok: true,
					status: 201,
					json: async () => ({
						signed_id: `blobid-${fileName}`,
						attachable_sgid: `sgid-${fileName}`,
						direct_upload: {
							url: "https://storage.example.com/upload-target",
							headers: { "Content-Type": "image/png" },
						},
					}),
				});
			}
			// PUT to signed URL
			return Promise.resolve({
				ok: true,
				status: 200,
				text: async () => "",
			});
		});
	}

	it("prefers attachable_sgid over signed_id (PR #1172 fix)", async () => {
		// Fizzy's direct_uploads returns BOTH signed_id (purpose: blob_id)
		// AND attachable_sgid (purpose: attachable). ActionText requires
		// the attachable variant. Verify the helper picks the right one.
		fetchMock.mockImplementation((_url: string, init?: RequestInit) => {
			if (!init || (init.method ?? "GET") === "GET") {
				return Promise.resolve({
					ok: true,
					status: 200,
					arrayBuffer: async () => new Uint8Array([1]).buffer,
					headers: { get: () => "image/png" },
				});
			}
			if (init.method === "POST") {
				return Promise.resolve({
					ok: true,
					status: 201,
					json: async () => ({
						signed_id: "WRONG-blob-id-sgid",
						attachable_sgid: "CORRECT-attachable-sgid",
						direct_upload: {
							url: "https://storage.example.com/x",
							headers: {},
						},
					}),
				});
			}
			return Promise.resolve({ ok: true, status: 200 });
		});
		const embeds = await resolveFizzyImageEmbeds(
			[{ src: "https://example.com/a.png", alt: "a", s3Key: null }],
			target,
		);
		expect(embeds[0]).toBe(
			'<action-text-attachment sgid="CORRECT-attachable-sgid"></action-text-attachment>',
		);
		expect(embeds[0]).not.toContain("WRONG-blob-id-sgid");
	});

	it("falls back to signed_id when attachable_sgid is absent (back-compat)", async () => {
		fetchMock.mockImplementation((_url: string, init?: RequestInit) => {
			if (!init || (init.method ?? "GET") === "GET") {
				return Promise.resolve({
					ok: true,
					status: 200,
					arrayBuffer: async () => new Uint8Array([1]).buffer,
					headers: { get: () => "image/png" },
				});
			}
			if (init.method === "POST") {
				return Promise.resolve({
					ok: true,
					status: 201,
					json: async () => ({
						signed_id: "fallback-sgid",
						// no attachable_sgid
						direct_upload: {
							url: "https://storage.example.com/x",
							headers: {},
						},
					}),
				});
			}
			return Promise.resolve({ ok: true, status: 200 });
		});
		const embeds = await resolveFizzyImageEmbeds(
			[{ src: "https://example.com/a.png", alt: "a", s3Key: null }],
			target,
		);
		expect(embeds[0]).toBe(
			'<action-text-attachment sgid="fallback-sgid"></action-text-attachment>',
		);
	});

	it("uploads each image and returns action-text-attachment embeds", async () => {
		mockSuccessfulUpload();
		const embeds = await resolveFizzyImageEmbeds(
			[
				{ src: "https://example.com/alpha.png", alt: "a", s3Key: null },
				{ src: "https://example.com/beta.png", alt: "b", s3Key: null },
			],
			target,
		);
		expect(embeds).toHaveLength(2);
		expect(embeds[0]).toBe(
			'<action-text-attachment sgid="sgid-alpha.png"></action-text-attachment>',
		);
		expect(embeds[1]).toBe(
			'<action-text-attachment sgid="sgid-beta.png"></action-text-attachment>',
		);
	});

	it("falls back to lexxy-figure with data: URL when upload fails", async () => {
		fetchMock.mockImplementation((_url: string, init?: RequestInit) => {
			if (!init || (init.method ?? "GET") === "GET") {
				return Promise.resolve({
					ok: true,
					status: 200,
					arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
					headers: { get: () => "image/png" },
				});
			}
			// direct_uploads fails
			return Promise.resolve({
				ok: false,
				status: 500,
				text: async () => "internal error",
			});
		});
		const embeds = await resolveFizzyImageEmbeds(
			[{ src: "https://example.com/c.png", alt: "c", s3Key: null }],
			target,
		);
		expect(embeds).toHaveLength(1);
		// Falls back to base64 lexxy figure
		expect(embeds[0]).toContain("lexxy-content__attachment-wrapper");
		expect(embeds[0]).toMatch(/src="data:image\/png;base64,[^"]+"/);
	});

	it("uses base64 inline when target is null (no attachment config)", async () => {
		fetchMock.mockResolvedValue({
			ok: true,
			status: 200,
			arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
			headers: { get: () => "image/png" },
		});
		const embeds = await resolveFizzyImageEmbeds(
			[{ src: "https://example.com/d.png", alt: "d", s3Key: null }],
			null,
		);
		expect(embeds).toHaveLength(1);
		expect(embeds[0]).toContain("lexxy-content__attachment-wrapper");
		expect(embeds[0]).toMatch(/src="data:image\/png;base64,[^"]+"/);
	});

	it("mixes attachment + base64 fallback when some uploads fail", async () => {
		let postCount = 0;
		fetchMock.mockImplementation((url: string, init?: RequestInit) => {
			if (!init || (init.method ?? "GET") === "GET") {
				return Promise.resolve({
					ok: true,
					status: 200,
					arrayBuffer: async () => new Uint8Array([1, 2]).buffer,
					headers: { get: () => "image/png" },
				});
			}
			if (init.method === "POST") {
				postCount++;
				if (postCount === 1) {
					// First upload succeeds
					return Promise.resolve({
						ok: true,
						status: 201,
						json: async () => ({
							signed_id: "blobid-ok",
							attachable_sgid: "sgid-ok",
							direct_upload: {
								url: "https://storage.example.com/up",
								headers: {},
							},
						}),
					});
				}
				// Second upload fails
				return Promise.resolve({
					ok: false,
					status: 500,
					text: async () => "fail",
				});
			}
			return Promise.resolve({ ok: true, status: 200 });
		});
		const embeds = await resolveFizzyImageEmbeds(
			[
				{ src: "https://example.com/x.png", alt: "x", s3Key: null },
				{ src: "https://example.com/y.png", alt: "y", s3Key: null },
			],
			target,
		);
		expect(embeds[0]).toContain("action-text-attachment");
		expect(embeds[0]).toContain("sgid-ok");
		expect(embeds[1]).toContain("lexxy-content__attachment-wrapper");
		expect(embeds[1]).toMatch(/src="data:image\/png;base64,/);
	});

	it("returns empty array for no images", async () => {
		const embeds = await resolveFizzyImageEmbeds([], target);
		expect(embeds).toEqual([]);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("skips data: URLs (already inlined) and non-HTTP refs", async () => {
		fetchMock.mockResolvedValue({
			ok: true,
			status: 200,
			arrayBuffer: async () => new Uint8Array([1]).buffer,
			headers: { get: () => "image/png" },
		});
		const embeds = await resolveFizzyImageEmbeds(
			[
				{
					src: "data:image/png;base64,abc=",
					alt: "inlined",
					s3Key: null,
				},
				{ src: "mailto:nope", alt: "weird", s3Key: null },
			],
			target,
		);
		expect(embeds).toHaveLength(2);
		// Both should fall back to lexxy figure (with their original src
		// since they can't be uploaded or base64'd from those scheme).
		expect(embeds[0]).toContain("lexxy-content__attachment-wrapper");
		expect(embeds[1]).toContain("lexxy-content__attachment-wrapper");
	});
});

describe("restoreFizzyImagesWithEmbeds", () => {
	it("substitutes <p>__FIZZY_IMG_N__</p> with the embed at index N", () => {
		const html = "<p>before</p>\n\n<p>__FIZZY_IMG_0__</p>\n\n<p>after</p>";
		const out = restoreFizzyImagesWithEmbeds(html, [
			'<action-text-attachment sgid="sgid-1"></action-text-attachment>',
		]);
		expect(out).toContain(
			'<action-text-attachment sgid="sgid-1"></action-text-attachment>',
		);
		expect(out).not.toContain("__FIZZY_IMG_0__");
	});
	it("substitutes a bare token outside <p> wrapper", () => {
		const html = "Block:\n\n__FIZZY_IMG_0__\n\ndone";
		const out = restoreFizzyImagesWithEmbeds(html, ["<embed-1/>"]);
		expect(out).toContain("<embed-1/>");
		expect(out).not.toContain("__FIZZY_IMG_0__");
	});
	it("no-ops on empty embeds array", () => {
		const html = "<p>__FIZZY_IMG_0__</p>";
		expect(restoreFizzyImagesWithEmbeds(html, [])).toBe(html);
	});
});

describe("rewriteFizzyInCellImagesHybrid", () => {
	const fetchMock = vi.fn();
	beforeEach(() => {
		fetchMock.mockReset();
		vi.stubGlobal("fetch", fetchMock);
	});

	const target = { apiKey: "fake", accountSlug: "/000001" };

	it("replaces in-cell <img> with action-text-attachment on upload success", async () => {
		fetchMock.mockImplementation((_url: string, init?: RequestInit) => {
			if (!init || (init.method ?? "GET") === "GET") {
				return Promise.resolve({
					ok: true,
					status: 200,
					arrayBuffer: async () => new Uint8Array([1]).buffer,
					headers: { get: () => "image/png" },
				});
			}
			if (init.method === "POST") {
				return Promise.resolve({
					ok: true,
					status: 201,
					json: async () => ({
						signed_id: "blobid-incell",
						attachable_sgid: "incell-sgid",
						direct_upload: {
							url: "https://storage.example.com/up",
							headers: {},
						},
					}),
				});
			}
			return Promise.resolve({ ok: true, status: 200 });
		});
		const html =
			'<td><p>before</p><img src="https://example.com/cell.png" alt="x"></td>';
		const out = await rewriteFizzyInCellImagesHybrid(html, target);
		expect(out).toContain(
			'<action-text-attachment sgid="incell-sgid"></action-text-attachment>',
		);
		expect(out).not.toContain("https://example.com/cell.png");
		expect(out).toContain("<p>before</p>");
	});

	it("falls back to base64 <img> when upload fails", async () => {
		fetchMock.mockImplementation((_url: string, init?: RequestInit) => {
			if (!init || (init.method ?? "GET") === "GET") {
				return Promise.resolve({
					ok: true,
					status: 200,
					arrayBuffer: async () => new Uint8Array([1]).buffer,
					headers: { get: () => "image/png" },
				});
			}
			return Promise.resolve({
				ok: false,
				status: 500,
				text: async () => "boom",
			});
		});
		const html = '<td><img src="https://example.com/x.png" alt="x"></td>';
		const out = await rewriteFizzyInCellImagesHybrid(html, target);
		// Falls back to inlined base64 img (PR #1163 behaviour) — embed
		// helper returns a full <figure> with data: URL. Replacement
		// substitutes whatever embed was resolved.
		expect(out).toContain("lexxy-content__attachment-wrapper");
		expect(out).toMatch(/src="data:image\/png;base64,/);
	});

	it("returns html untouched when there are no <img> tags", async () => {
		const html = "<td>just text</td>";
		const out = await rewriteFizzyInCellImagesHybrid(html, target);
		expect(out).toBe(html);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("uses base64 inline path when target is null", async () => {
		fetchMock.mockResolvedValue({
			ok: true,
			status: 200,
			arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
			headers: { get: () => "image/png" },
		});
		const html = '<td><img src="https://example.com/y.png" alt="y"></td>';
		const out = await rewriteFizzyInCellImagesHybrid(html, null);
		expect(out).toContain("lexxy-content__attachment-wrapper");
		expect(out).toMatch(/src="data:image\/png;base64,/);
		// No POST call attempted.
		const postCalls = fetchMock.mock.calls.filter(
			(c) => c[1]?.method === "POST",
		);
		expect(postCalls).toHaveLength(0);
	});
});

// =============================================================================
// Hybrid Atlassian Cloud — Jira REST attachment upload (PR #1169)
// =============================================================================

describe("resolveJiraCloudTarget", () => {
	const decrypt = (s: string) =>
		s === "BAD"
			? (() => {
					throw new Error("decrypt");
				})()
			: `plain:${s}`;

	it("returns null when no options object is provided", async () => {
		const target = await resolveJiraCloudTarget({
			id: "cfg_1",
			encryptedAtlassianCloudAccessToken: "ENC",
			atlassianCloudCloudId: "cid",
			atlassianCloudSiteUrl: "https://acme.atlassian.net",
		});
		expect(target).toBeNull();
	});

	it("returns null when access token is missing", async () => {
		const target = await resolveJiraCloudTarget(
			{
				id: "cfg_1",
				encryptedAtlassianCloudAccessToken: null,
				atlassianCloudCloudId: "cid",
				atlassianCloudSiteUrl: "https://acme.atlassian.net",
			},
			{ decrypt },
		);
		expect(target).toBeNull();
	});

	it("returns null when cloudId is missing", async () => {
		const target = await resolveJiraCloudTarget(
			{
				id: "cfg_1",
				encryptedAtlassianCloudAccessToken: "ENC",
				atlassianCloudCloudId: null,
				atlassianCloudSiteUrl: "https://acme.atlassian.net",
			},
			{ decrypt },
		);
		expect(target).toBeNull();
	});

	it("returns null when siteUrl is missing", async () => {
		const target = await resolveJiraCloudTarget(
			{
				id: "cfg_1",
				encryptedAtlassianCloudAccessToken: "ENC",
				atlassianCloudCloudId: "cid",
				atlassianCloudSiteUrl: null,
			},
			{ decrypt },
		);
		expect(target).toBeNull();
	});

	it("returns a target when all fields present + token not expired", async () => {
		const target = await resolveJiraCloudTarget(
			{
				id: "cfg_1",
				encryptedAtlassianCloudAccessToken: "ENC",
				atlassianCloudCloudId: "cid",
				atlassianCloudSiteUrl: "https://acme.atlassian.net",
				atlassianCloudTokenExpiresAt: new Date(Date.now() + 3600_000),
			},
			{ decrypt },
		);
		expect(target).toEqual({
			accessToken: "plain:ENC",
			cloudId: "cid",
			siteUrl: "https://acme.atlassian.net",
			mcpConfigId: "cfg_1",
			// No stored accessible-resources → falls back to the primary site.
			resources: [
				{ cloudId: "cid", siteUrl: "https://acme.atlassian.net" },
			],
		});
	});

	it("exposes all accessible resources when stored", async () => {
		const target = await resolveJiraCloudTarget(
			{
				id: "cfg_1",
				encryptedAtlassianCloudAccessToken: "ENC",
				atlassianCloudCloudId: "cid-a",
				atlassianCloudSiteUrl: "https://a.atlassian.net",
				atlassianCloudAccessibleResources: [
					{ id: "cid-a", url: "https://a.atlassian.net", name: "A" },
					{ id: "cid-b", url: "https://b.atlassian.net", name: "B" },
				],
			},
			{ decrypt },
		);
		expect(target?.resources).toEqual([
			{ cloudId: "cid-a", siteUrl: "https://a.atlassian.net" },
			{ cloudId: "cid-b", siteUrl: "https://b.atlassian.net" },
		]);
	});

	it("returns null when token expired and no refresh callback provided", async () => {
		const target = await resolveJiraCloudTarget(
			{
				id: "cfg_1",
				encryptedAtlassianCloudAccessToken: "ENC",
				atlassianCloudCloudId: "cid",
				atlassianCloudSiteUrl: "https://acme.atlassian.net",
				atlassianCloudTokenExpiresAt: new Date(Date.now() - 1000),
			},
			{ decrypt },
		);
		expect(target).toBeNull();
	});

	it("invokes refresh callback when token is expiring within 60s", async () => {
		const refreshIfExpired = vi.fn(async () => ({
			accessToken: "rotated-token",
		}));
		const target = await resolveJiraCloudTarget(
			{
				id: "cfg_1",
				encryptedAtlassianCloudAccessToken: "ENC",
				atlassianCloudCloudId: "cid",
				atlassianCloudSiteUrl: "https://acme.atlassian.net",
				atlassianCloudTokenExpiresAt: new Date(Date.now() + 30_000),
			},
			{ decrypt, refreshIfExpired },
		);
		expect(refreshIfExpired).toHaveBeenCalledWith("cfg_1");
		expect(target?.accessToken).toBe("rotated-token");
	});

	it("returns null when refresh callback returns null (refresh failed)", async () => {
		const refreshIfExpired = vi.fn(async () => null);
		const target = await resolveJiraCloudTarget(
			{
				id: "cfg_1",
				encryptedAtlassianCloudAccessToken: "ENC",
				atlassianCloudCloudId: "cid",
				atlassianCloudSiteUrl: "https://acme.atlassian.net",
				atlassianCloudTokenExpiresAt: new Date(Date.now() - 1000),
			},
			{ decrypt, refreshIfExpired },
		);
		expect(target).toBeNull();
	});

	it("returns null when decrypt throws", async () => {
		const target = await resolveJiraCloudTarget(
			{
				id: "cfg_1",
				encryptedAtlassianCloudAccessToken: "BAD",
				atlassianCloudCloudId: "cid",
				atlassianCloudSiteUrl: "https://acme.atlassian.net",
			},
			{ decrypt },
		);
		expect(target).toBeNull();
	});
});

describe("uploadJiraImagesAndRewriteDescription", () => {
	const target = {
		accessToken: "tok",
		cloudId: "cid",
		siteUrl: "https://acme.atlassian.net",
		mcpConfigId: "cfg_1",
		resources: [{ cloudId: "cid", siteUrl: "https://acme.atlassian.net" }],
	};
	const site = { cloudId: "cid", siteUrl: "https://acme.atlassian.net" };

	beforeEach(() => {
		const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
			if (init?.method === "POST") {
				return {
					ok: true,
					status: 201,
					json: async () => [
						{ id: "12345", filename: "screenshot-001.png" },
					],
					text: async () => "",
				};
			}
			// GET image — return blob bytes
			return {
				ok: true,
				status: 200,
				blob: async () => new Blob([new Uint8Array([1, 2, 3])]),
			};
		});
		vi.stubGlobal("fetch", fetchMock);
	});

	it("rewrites markdown ![](url) image refs to site-direct attachment URLs", async () => {
		const desc =
			"Hello\n\n![alt](https://signed.example.com/a.png)\n\nWorld";
		const result = await uploadJiraImagesAndRewriteDescription(
			desc,
			target,
			site,
			"KAN-99",
		);
		expect(result.uploaded).toBe(1);
		expect(result.failed).toBe(0);
		expect(result.description).toContain(
			"https://acme.atlassian.net/secure/attachment/12345/screenshot-001.png",
		);
		expect(result.description).not.toContain(
			"https://signed.example.com/a.png",
		);
	});

	it("rewrites <img> HTML survivor tags as well", async () => {
		const desc =
			'<p>Hi</p><img src="https://signed.example.com/b.png" alt="b"><p>End</p>';
		const result = await uploadJiraImagesAndRewriteDescription(
			desc,
			target,
			site,
			"KAN-99",
		);
		expect(result.uploaded).toBe(1);
		expect(result.description).toContain(
			"https://acme.atlassian.net/secure/attachment/12345/screenshot-001.png",
		);
	});

	it("skips already-attached /secure/attachment/ URLs", async () => {
		const desc =
			"![alt](https://acme.atlassian.net/secure/attachment/999/x.png)";
		const result = await uploadJiraImagesAndRewriteDescription(
			desc,
			target,
			site,
			"KAN-99",
		);
		expect(result.uploaded).toBe(0);
		expect(result.description).toBe(desc);
	});

	it("skips non-HTTP, non-data: URLs (e.g. 'url' from broken syntax)", async () => {
		const desc = "![alt](url)";
		const result = await uploadJiraImagesAndRewriteDescription(
			desc,
			target,
			site,
			"KAN-99",
		);
		expect(result.uploaded).toBe(0);
		expect(result.description).toBe(desc);
	});

	it("counts failures and keeps original URL when upload returns 4xx", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string, init?: RequestInit) => {
				if (init?.method === "POST") {
					return {
						ok: false,
						status: 400,
						text: async () => "bad payload",
						json: async () => null,
					};
				}
				return {
					ok: true,
					status: 200,
					blob: async () => new Blob([new Uint8Array([1, 2, 3])]),
				};
			}),
		);
		const desc = "![alt](https://signed.example.com/c.png)";
		const result = await uploadJiraImagesAndRewriteDescription(
			desc,
			target,
			site,
			"KAN-99",
		);
		expect(result.uploaded).toBe(0);
		expect(result.failed).toBe(1);
		expect(result.description).toBe(desc); // unchanged
		// Regression guard: the failure reason must be surfaced (not swallowed)
		// so a silent SUCCESS-with-no-image becomes diagnosable. The HTTP status
		// distinguishes an auth/permission 4xx from a network/egress failure.
		expect(result.errors).toHaveLength(1);
		expect(result.errors[0]).toContain("400");
	});

	it("surfaces a network/egress failure reason when the POST throws", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_input: string, init?: RequestInit) => {
				if (init?.method === "POST") {
					throw new Error("getaddrinfo ENOTFOUND api.atlassian.com");
				}
				return {
					ok: true,
					status: 200,
					blob: async () => new Blob([new Uint8Array([1, 2, 3])]),
				};
			}),
		);
		const result = await uploadJiraImagesAndRewriteDescription(
			"![alt](https://signed.example.com/c.png)",
			target,
			site,
			"KAN-99",
		);
		expect(result.uploaded).toBe(0);
		expect(result.failed).toBe(1);
		expect(result.errors[0]).toContain("api.atlassian.com");
	});

	it("includes data: URLs by default (replaces base64 inline with attachment)", async () => {
		const desc = "![alt](data:image/png;base64,iVBORw0KGgoAAA)";
		const result = await uploadJiraImagesAndRewriteDescription(
			desc,
			target,
			site,
			"KAN-99",
		);
		expect(result.uploaded).toBe(1);
		expect(result.description).toContain(
			"https://acme.atlassian.net/secure/attachment/12345/screenshot-001.png",
		);
	});

	it("skips data: URLs when includeDataUrls: false", async () => {
		const desc = "![alt](data:image/png;base64,iVBORw0KGgoAAA)";
		const result = await uploadJiraImagesAndRewriteDescription(
			desc,
			target,
			site,
			"KAN-99",
			{ includeDataUrls: false },
		);
		expect(result.uploaded).toBe(0);
		expect(result.description).toBe(desc);
	});

	it("returns no-op when description has no image references", async () => {
		const desc = "Just text, no images.";
		const result = await uploadJiraImagesAndRewriteDescription(
			desc,
			target,
			site,
			"KAN-99",
		);
		expect(result.uploaded).toBe(0);
		expect(result.description).toBe(desc);
	});

	it("uploads multiple distinct images and rewrites each", async () => {
		let counter = 0;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_input: string, init?: RequestInit) => {
				if (init?.method === "POST") {
					counter += 1;
					// Snapshot the counter synchronously per-call —
					// otherwise `json()` (awaited later) captures the
					// shared counter by reference and both responses
					// surface the LAST observed value.
					const snapshot = counter;
					return {
						ok: true,
						status: 201,
						json: async () => [
							{
								id: `id-${snapshot}`,
								filename: `screenshot-${snapshot}.png`,
							},
						],
						text: async () => "",
					};
				}
				return {
					ok: true,
					status: 200,
					blob: async () => new Blob([new Uint8Array([1, 2, 3])]),
				};
			}),
		);
		const desc =
			"![a](https://x.example/a.png) and ![b](https://x.example/b.png)";
		const result = await uploadJiraImagesAndRewriteDescription(
			desc,
			target,
			site,
			"KAN-99",
		);
		expect(result.uploaded).toBe(2);
		expect(result.description).toContain(
			"https://acme.atlassian.net/secure/attachment/id-1/screenshot-1.png",
		);
		expect(result.description).toContain(
			"https://acme.atlassian.net/secure/attachment/id-2/screenshot-2.png",
		);
	});
});

describe("resolveIssueSite — multi-site routing", () => {
	const multiTarget = {
		accessToken: "tok",
		cloudId: "cid-a",
		siteUrl: "https://a.atlassian.net",
		mcpConfigId: "cfg_1",
		resources: [
			{ cloudId: "cid-a", siteUrl: "https://a.atlassian.net" },
			{ cloudId: "cid-b", siteUrl: "https://b.atlassian.net" },
		],
	};

	it("resolves the issue's site from an api.atlassian.com/ex/jira/{cloudId} externalUrl", () => {
		const site = resolveIssueSite(
			multiTarget,
			"https://api.atlassian.com/ex/jira/cid-b/rest/api/3/issue/10033",
		);
		expect(site).toEqual({
			cloudId: "cid-b",
			siteUrl: "https://b.atlassian.net",
		});
	});

	it("resolves the issue's site from a {site}.atlassian.net/browse externalUrl", () => {
		const site = resolveIssueSite(
			multiTarget,
			"https://a.atlassian.net/browse/KAN-7",
		);
		expect(site).toEqual({
			cloudId: "cid-a",
			siteUrl: "https://a.atlassian.net",
		});
	});

	it("returns null when the issue's cloudId is NOT in the granted resources (degrade)", () => {
		const site = resolveIssueSite(
			multiTarget,
			"https://api.atlassian.com/ex/jira/cid-OTHER/rest/api/3/issue/55",
		);
		expect(site).toBeNull();
	});

	it("returns null when the issue host is NOT a granted site", () => {
		const site = resolveIssueSite(
			multiTarget,
			"https://stranger.atlassian.net/browse/X-1",
		);
		expect(site).toBeNull();
	});

	it("returns null for a null/empty externalUrl", () => {
		expect(resolveIssueSite(multiTarget, null)).toBeNull();
		expect(resolveIssueSite(multiTarget, "")).toBeNull();
	});
});

describe("uploadJiraImagesAndRewriteDescription — multi-site target", () => {
	beforeEach(() => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string, init?: RequestInit) => {
				if (init?.method === "POST") {
					return {
						ok: true,
						status: 201,
						json: async () => [
							{ id: "att-1", filename: "screenshot-001.png" },
						],
						text: async () => "",
					};
				}
				return {
					ok: true,
					status: 200,
					blob: async () => new Blob([new Uint8Array([1, 2, 3])]),
				};
			}),
		);
	});

	it("uploads to the issue's resolved site, not the token's primary site", async () => {
		const target = {
			accessToken: "tok",
			cloudId: "cid-a",
			siteUrl: "https://a.atlassian.net", // primary
			mcpConfigId: "cfg_1",
			resources: [
				{ cloudId: "cid-a", siteUrl: "https://a.atlassian.net" },
				{ cloudId: "cid-b", siteUrl: "https://b.atlassian.net" },
			],
		};
		// Issue lives on site B.
		const site = resolveIssueSite(
			target,
			"https://api.atlassian.com/ex/jira/cid-b/rest/api/3/issue/10033",
		)!;
		const result = await uploadJiraImagesAndRewriteDescription(
			"![alt](https://signed.example.com/a.png)",
			target,
			site,
			"PROJ-1",
		);
		expect(result.uploaded).toBe(1);
		// Rewritten URL must use site B's host (the issue's site), not A.
		expect(result.description).toContain(
			"https://b.atlassian.net/secure/attachment/att-1/screenshot-001.png",
		);
		expect(result.description).not.toContain("a.atlassian.net/secure");
		// And the upload POST must hit site B's cloudId.
		const fetchMock = globalThis.fetch as unknown as {
			mock: { calls: Array<[string, RequestInit?]> };
		};
		const postCall = fetchMock.mock.calls.find(
			(c) => c[1]?.method === "POST",
		);
		expect(postCall?.[0]).toContain("/ex/jira/cid-b/");
	});
});

// -----------------------------------------------------------------------------
// stripImagesForJira — remove raw <img>/markdown images, capture their srcs
// (so the Jira body ships clean text and the images re-embed as ADF media)
// -----------------------------------------------------------------------------

describe("stripImagesForJira", () => {
	it("strips <img> tags and returns the src", () => {
		const { text, srcs } = stripImagesForJira(
			'Before\n\n<img data-s3-key="story-media/p/s/x.png" src="https://signed.example.com/x.png?Sig=1" alt="shot">\n\nAfter',
		);
		expect(text).toBe("Before\n\nAfter");
		expect(srcs).toEqual(["https://signed.example.com/x.png?Sig=1"]);
	});

	it("strips markdown images and returns the url", () => {
		const { text, srcs } = stripImagesForJira(
			"Top\n\n![flow](https://signed.example.com/d.png?Sig=2)\n\nBottom",
		);
		expect(text).toBe("Top\n\nBottom");
		expect(srcs).toEqual(["https://signed.example.com/d.png?Sig=2"]);
	});

	it("captures multiple images in document order and leaves non-image text intact", () => {
		const { text, srcs } = stripImagesForJira(
			'<img src="https://a/1.png"> middle ![b](https://a/2.png) end',
		);
		expect(srcs).toEqual(["https://a/1.png", "https://a/2.png"]);
		expect(text).toContain("middle");
		expect(text).toContain("end");
		expect(text).not.toContain("<img");
		expect(text).not.toContain("![b]");
	});

	it("is a no-op for image-free text", () => {
		const { text, srcs } = stripImagesForJira("just words, no pictures");
		expect(text).toBe("just words, no pictures");
		expect(srcs).toEqual([]);
	});
});
