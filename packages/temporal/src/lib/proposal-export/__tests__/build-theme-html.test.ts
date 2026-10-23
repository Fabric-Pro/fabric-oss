import { buildProposalThemeTokens } from "@repo/utils/proposal-artifact/theme-tokens";
import sharp from "sharp";
import { beforeAll, describe, expect, it } from "vitest";
import {
	type BuildThemeHtmlInput,
	buildThemeHtml,
	MAX_EMBEDDED_IMAGE_CHARS,
	PAGE_MARKER_PATTERN,
	pageMarkerText,
	type ThemeHtmlPass,
} from "../build-theme-html";
import { prepareExportMarkdown } from "../markdown";
import type { ExportDiagram, ExportRaster, ExportThemeTokens } from "../types";

const PROJECT = "project-example-1";
const DOCUMENT = "document-example-1";
const TITLE = "Example Proposal";
const DATE = "October 15, 2026";

const FINAL: ThemeHtmlPass = { kind: "final", pageNumbers: new Map() };
const LOCATE: ThemeHtmlPass = { kind: "locate" };

let png: ExportRaster;
let jpeg: ExportRaster;

beforeAll(async () => {
	const raster = async (
		format: "png" | "jpeg",
		alpha: boolean,
	): Promise<ExportRaster> => ({
		mimeType: format === "png" ? "image/png" : "image/jpeg",
		bytes: await sharp({
			create: {
				width: 8,
				height: 6,
				channels: alpha ? 4 : 3,
				background: { r: 20, g: 80, b: 160, alpha: 1 },
			},
		})
			.toFormat(format)
			.toBuffer(),
		width: 8,
		height: 6,
	});
	png = await raster("png", true);
	jpeg = await raster("jpeg", false);
});

interface TokenOptions {
	proposerName?: string | null;
	recipientName?: string | null;
	proposerLogo?: ExportRaster | null;
	recipientLogo?: ExportRaster | null;
	hero?: ExportRaster | null;
	bodyFont?: string;
}

function exportTokens(options: TokenOptions = {}): ExportThemeTokens {
	const base = buildProposalThemeTokens({
		organization: {
			name:
				options.proposerName === undefined
					? "Example Org"
					: options.proposerName,
			logoKey: null,
		},
		style: { primaryColor: "#1d4ed8", accentColors: [] },
		brandKit: null,
		recipient: {
			name:
				options.recipientName === undefined
					? "Example Client"
					: options.recipientName,
			logoKey: null,
			colors: [],
		},
	});
	const asset = (raster: ExportRaster | null | undefined) =>
		raster
			? { value: raster, source: "BRAND_KIT" as const }
			: { value: null, source: "DEFAULT" as const };
	return {
		proposer: {
			...base.proposer,
			logo: asset(options.proposerLogo),
			hero: asset(options.hero),
			fonts: options.bodyFont
				? {
						display: { value: options.bodyFont, source: "MANUAL" },
						body: { value: options.bodyFont, source: "MANUAL" },
						mono: { value: options.bodyFont, source: "MANUAL" },
					}
				: base.proposer.fonts,
		},
		recipient: { ...base.recipient, logo: asset(options.recipientLogo) },
	};
}

function build(markdown: string, overrides: Partial<BuildThemeHtmlInput> = {}) {
	return buildThemeHtml({
		prepared: prepareExportMarkdown(markdown),
		diagrams: [],
		images: new Map(),
		tokens: exportTokens(),
		projectId: PROJECT,
		documentId: DOCUMENT,
		title: TITLE,
		dateLabel: DATE,
		pass: FINAL,
		...overrides,
	});
}

/** What follows the theme's stylesheets: the page as a reader sees it. */
function bodyOf(html: string): string {
	const start = html.indexOf("<body");
	expect(start).toBeGreaterThan(-1);
	return html.slice(start);
}

/** Every start tag on the page, with its name and attribute text. */
function startTags(html: string): { name: string; attributes: string }[] {
	return Array.from(
		html.matchAll(/<([a-zA-Z][a-zA-Z0-9-]*)((?:\s[^<>]*)?)>/g),
		(match) => ({
			name: (match[1] as string).toLowerCase(),
			attributes: match[2] ?? "",
		}),
	);
}

function attribute(attributes: string, name: string): string | null {
	const match = new RegExp(`\\s${name}="([^"]*)"`).exec(attributes);
	return match ? (match[1] ?? "") : null;
}

function mediaKey(name: string, documentId = DOCUMENT): string {
	return `document-media/${PROJECT}/${documentId}/${name}`;
}

function imageTag(key: string, extra = ""): string {
	return `<img src="https://example.com/signed/image.png" alt="Example chart" width="320" data-s3-key="${key}" ${extra}/>`;
}

describe("buildThemeHtml: the document", () => {
	it("is one self-contained themed page", () => {
		const { html } = build("Intro paragraph.");

		expect(
			html.startsWith('<!doctype html>\n<html lang="en" style="'),
		).toBe(true);
		expect(html).toContain('<meta charset="utf-8">');
		expect(html).toContain(`<title>${TITLE}</title>`);
		expect(html.match(/<style>/g)).toHaveLength(2);
		expect(html).toContain("@font-face");
		expect(html).toContain('<body data-proposal-theme="print">');
		const htmlTag = startTags(html).find((tag) => tag.name === "html");
		expect(attribute(htmlTag?.attributes ?? "", "style")).toMatch(
			/^--pa-surface: #[0-9a-f]{6}; --pa-ink: /,
		);
	});

	it("prints every font in Inter, whatever the brand names", () => {
		const { html } = build("Text.", {
			tokens: exportTokens({ bodyFont: "Example Sans" }),
		});

		expect(html).not.toContain("Example Sans");
		const style =
			attribute(
				startTags(html).find((tag) => tag.name === "html")
					?.attributes ?? "",
				"style",
			) ?? "";
		for (const role of ["display", "body", "mono"]) {
			expect(style).toContain(`--pa-font-${role}: &quot;Inter&quot;`);
		}
	});

	it("writes the running footer from the parts the data holds", () => {
		const footer = (html: string) =>
			/@bottom-left \{[^}]*content: "([^"]*)"/.exec(html)?.[1];

		expect(footer(build("Text.").html)).toBe(
			"Example Org · Example Proposal · October 15, 2026 · Confidential",
		);
		expect(
			footer(
				build("Text.", {
					tokens: exportTokens({ proposerName: null }),
					dateLabel: " ",
				}).html,
			),
		).toBe("Example Proposal · Confidential");
		expect(
			/@top-left \{[^}]*content: "([^"]*)"/.exec(build("x").html)?.[1],
		).toBe(TITLE);
	});

	it("scrubs citations and the Source Index, and keeps everything else as the page shows it", () => {
		const { html, sections } = build(
			[
				"Our approach cuts onboarding time [S3].",
				"",
				"## Approach",
				"",
				"TBD",
				"",
				"## Appendix",
				"",
				"Supporting detail stays.",
				"",
				"## Source Index",
				"",
				"- [S1] Example source one",
				"- [S3] Example source three",
			].join("\n"),
		);
		const body = bodyOf(html);

		expect(body).not.toContain("[S3]");
		expect(body).not.toContain("Source Index");
		expect(body).not.toContain("Example source");
		expect(body).toContain("<p>Our approach cuts onboarding time.</p>");
		expect(body).toContain("<p>TBD</p>");
		expect(body).toContain("<p>Supporting detail stays.</p>");
		expect(sections.map((section) => section.title)).toEqual([
			"Approach",
			"Appendix",
		]);
	});
});

describe("buildThemeHtml: untrusted content", () => {
	it("prints raw HTML as escaped text and never as markup", () => {
		const { html, warnings } = build(
			[
				"<img src=x onerror=alert(1)>",
				"",
				"<script>alert(document.cookie)</script>",
				"",
				'Inline <span onclick="alert(1)">x</span> and <a href="javascript:alert(1)">y</a>.',
				"",
				"<div>",
				'<iframe src="https://example.com/frame"></iframe>',
				"</div>",
			].join("\n"),
		);
		const body = bodyOf(html);

		// An image tag with no stored upload names a URL the export never
		// fetches: it is left out and reported, not printed.
		expect(body).not.toContain("onerror");
		expect(warnings).toContainEqual({
			code: "EXTERNAL_IMAGE_DROPPED",
			count: 1,
		});
		expect(body).toContain(
			"&lt;script&gt;alert(document.cookie)&lt;/script&gt;",
		);
		expect(body).toContain(
			"Inline &lt;span onclick=&quot;alert(1)&quot;&gt;x&lt;/span&gt;",
		);
		expect(html).not.toMatch(/<script/i);
		expect(html).not.toMatch(/<iframe/i);
		for (const tag of startTags(html)) {
			expect({
				tag,
				handler: /\son[a-z]+\s*=/i.test(tag.attributes),
			}).toEqual({ tag, handler: false });
		}
	});

	it("keeps line breaks, leaves comments out and escapes text everywhere", () => {
		const { html } = build(
			[
				"First line<br>second line<br />third",
				"",
				"<!-- internal note: margin 40% -->",
				"",
				"Quotes \" and ' and & and <b>bold</b> stay text.",
				"",
				"`<code>` stays code.",
			].join("\n"),
		);
		const body = bodyOf(html);

		expect(body).toContain("<p>First line<br>second line<br>third</p>");
		expect(body).not.toContain("internal note");
		expect(body).toContain(
			"Quotes &quot; and &#39; and &amp; and &lt;b&gt;bold&lt;/b&gt; stay text.",
		);
		expect(body).toContain("<code>&lt;code&gt;</code> stays code.");
	});

	it("keeps only http(s), mailto and fragment links as links", () => {
		const { html } = build(
			[
				"[script](javascript:alert(1))",
				"[file](file:///etc/passwd)",
				"[data](data:text/html;base64,PHNjcmlwdD4=)",
				"[web](https://example.com/plan)",
				"[plain](http://example.com/)",
				"[mail](mailto:dev@example.com)",
				"[section](#pa-section-1)",
				"[ref][example]",
				"",
				"[example]: https://example.com/reference",
			].join("\n"),
		);
		const anchors = startTags(bodyOf(html))
			.filter((tag) => tag.name === "a")
			.map((tag) => attribute(tag.attributes, "href"));

		expect(anchors).toEqual([
			"https://example.com/plan",
			"http://example.com/",
			"mailto:dev@example.com",
			"#pa-section-1",
			"https://example.com/reference",
		]);
		const body = bodyOf(html);
		expect(body).not.toMatch(/javascript:|file:|data:text/);
		expect(body).toContain("script\nfile\ndata\n");
	});

	it("loads nothing: http(s) appears only in kept links and text", () => {
		const diagram: ExportDiagram = {
			kind: "svg",
			svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"></rect></svg>',
			width: 10,
			height: 10,
			png: null,
		};
		const { html } = build(
			[
				"## Overview",
				"",
				"See https://example.com/visible and [a link](https://example.com/kept).",
				"",
				"![remote](https://example.com/remote.png)",
				"",
				imageTag(mediaKey("chart.png")),
				"",
				"```mermaid",
				"flowchart LR",
				"  A --> B",
				"```",
			].join("\n"),
			{
				diagrams: [diagram],
				images: new Map([[mediaKey("chart.png"), png]]),
				tokens: exportTokens({
					proposerLogo: png,
					recipientLogo: jpeg,
					hero: jpeg,
				}),
			},
		);

		expect(html).not.toMatch(/url\(\s*["']?\s*(?!data:)[a-z]+:/i);
		expect(html).not.toMatch(/<(link|base|object|embed|iframe|script)\b/i);
		let sources = 0;
		for (const tag of startTags(html)) {
			const src = attribute(tag.attributes, "src");
			if (src !== null) {
				sources++;
				expect(src).toMatch(
					/^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/,
				);
			}
			if (tag.name !== "a") {
				expect(attribute(tag.attributes, "href")).toBeNull();
			}
		}
		// Two logos, the hero and the uploaded image.
		expect(sources).toBe(4);
		expect(html).not.toContain("remote.png");
	});

	it("drops Markdown images and counts them, without fetching anything", () => {
		const { html, warnings } = build(
			[
				"![remote](https://example.com/remote.png)",
				"",
				"Text ![inline](https://example.com/inline.png) here.",
				"",
				"![ref][logo]",
				"",
				"[logo]: https://example.com/logo.png",
			].join("\n"),
		);

		expect(bodyOf(html)).not.toMatch(/example\.com\/(remote|inline|logo)/);
		expect(bodyOf(html)).toContain("<p>Text  here.</p>");
		expect(warnings).toEqual([
			{ code: "EXTERNAL_IMAGE_DROPPED", count: 3 },
		]);
	});
});

describe("buildThemeHtml: uploaded images", () => {
	it("prints the document's own image as a figure of its re-encoded bytes", () => {
		const { html } = build(
			imageTag(
				mediaKey("chart.png"),
				'data-caption="Example &amp; caption"',
			),
			{ images: new Map([[mediaKey("chart.png"), png]]) },
		);

		expect(bodyOf(html)).toContain(
			`<figure class="pa-figure"><img src="data:image/png;base64,${png.bytes.toString("base64")}" alt="Example chart" style="width: 320px"><figcaption class="pa-caption">Example &amp; caption</figcaption></figure>`,
		);
	});

	it("leaves out an image outside the document's prefix or without bytes, silently", () => {
		const foreign = mediaKey("other.png", "document-example-2");
		const { html, warnings } = build(
			[
				imageTag(foreign),
				"",
				imageTag(mediaKey("missing.png")),
				"",
				`Inline ${imageTag(foreign)} too.`,
			].join("\n"),
			// Even when a caller hands over bytes for the foreign key.
			{ images: new Map([[foreign, png]]) },
		);
		const body = bodyOf(html);

		expect(body).not.toContain("<figure");
		expect(body).not.toContain("<img");
		expect(body).not.toContain("data-s3-key");
		expect(body).not.toContain("Example chart");
		expect(body).toContain("<p>Inline  too.</p>");
		expect(warnings).toEqual([]);
	});
});

describe("buildThemeHtml: cover", () => {
	const coverOf = (html: string) => {
		const body = bodyOf(html);
		const start = body.indexOf('<section class="pa-cover">');
		return body.slice(start, body.indexOf("</section>", start) + 10);
	};

	it("opens the body, block-level, with data-held fields only and no lead", () => {
		const { html } = build("Text.");
		const cover = coverOf(html);

		expect(bodyOf(html)).toMatch(
			/^<body data-proposal-theme="print">\n<section class="pa-cover">/,
		);
		expect(cover).toBe(
			'<section class="pa-cover"><div class="pa-cover-brands"></div><div class="pa-cover-body"><p class="pa-eyebrow">Proposal</p><h1 class="pa-cover-title">Example Proposal</h1></div><dl class="pa-cover-parties"><div><dt>Prepared for</dt><dd>Example Client</dd></div><div><dt>Prepared by</dt><dd>Example Org</dd></div></dl><p class="pa-cover-date">October 15, 2026</p></section>',
		);
		expect(cover).not.toContain("pa-cover-lead");
	});

	it("draws both logos when both tokens hold one", () => {
		const cover = coverOf(
			build("Text.", {
				tokens: exportTokens({
					proposerLogo: png,
					recipientLogo: jpeg,
				}),
			}).html,
		);

		expect(cover).toContain(
			`<div class="pa-cover-brands"><img class="pa-cover-logo pa-cover-logo-proposer" src="data:image/png;base64,${png.bytes.toString("base64")}" alt="Example Org logo"><img class="pa-cover-logo pa-cover-logo-recipient" src="data:image/jpeg;base64,${jpeg.bytes.toString("base64")}" alt="Example Client logo"></div>`,
		);
	});

	it("draws one logo alone, and an empty brands row with nothing inside", () => {
		const recipientOnly = coverOf(
			build("Text.", { tokens: exportTokens({ recipientLogo: png }) })
				.html,
		);
		expect(recipientOnly).toMatch(
			/<div class="pa-cover-brands"><img class="pa-cover-logo pa-cover-logo-recipient" [^>]*><\/div>/,
		);
		expect(recipientOnly).not.toContain("pa-cover-logo-proposer");

		const none = coverOf(build("Text.").html);
		expect(none).toContain('<div class="pa-cover-brands"></div>');
	});

	it("leaves out a missing party, and the parties list when neither is known", () => {
		const noRecipient = coverOf(
			build("Text.", { tokens: exportTokens({ recipientName: "  " }) })
				.html,
		);
		expect(noRecipient).not.toContain("Prepared for");
		expect(noRecipient).toContain(
			'<dl class="pa-cover-parties"><div><dt>Prepared by</dt><dd>Example Org</dd></div></dl>',
		);

		const nobody = coverOf(
			build("Text.", {
				tokens: exportTokens({
					recipientName: null,
					proposerName: null,
				}),
			}).html,
		);
		expect(nobody).not.toContain("pa-cover-parties");
		expect(nobody).not.toContain("Prepared");
	});

	it("draws the hero only when there is one", () => {
		expect(coverOf(build("Text.").html)).not.toContain("pa-cover-hero");
		expect(
			coverOf(
				build("Text.", { tokens: exportTokens({ hero: jpeg }) }).html,
			),
		).toContain(
			`</div><img class="pa-cover-hero" src="data:image/jpeg;base64,${jpeg.bytes.toString("base64")}" alt=""><div class="pa-cover-body">`,
		);
	});

	it("escapes the title and the names", () => {
		const { html } = build("Text.", {
			title: 'Q3 <Plan> & "More"',
			tokens: exportTokens({ proposerName: "<b>Example</b> Org" }),
		});

		expect(html).toContain(
			"<title>Q3 &lt;Plan&gt; &amp; &quot;More&quot;</title>",
		);
		expect(coverOf(html)).toContain(
			'<h1 class="pa-cover-title">Q3 &lt;Plan&gt; &amp; &quot;More&quot;</h1>',
		);
		expect(coverOf(html)).toContain(
			"<dd>&lt;b&gt;Example&lt;/b&gt; Org</dd>",
		);
	});
});

describe("buildThemeHtml: sections and contents", () => {
	const DOC = [
		"Intro.",
		"",
		"## Executive *Summary*",
		"",
		"Text.",
		"",
		"> ## Not a section",
		"",
		"### Detail",
		"",
		"## Pricing & Terms",
		"",
		"## Appendix",
	].join("\n");

	const contentsOf = (html: string) => {
		const start = html.indexOf('<nav class="pa-contents"');
		return start === -1
			? ""
			: html.slice(start, html.indexOf("</nav>", start));
	};

	it("opens a section at every root-level H2 and lists each in order", () => {
		const { html, sections } = build(DOC);

		expect(sections).toEqual([
			{ index: 1, id: "pa-section-1", title: "Executive Summary" },
			{ index: 2, id: "pa-section-2", title: "Pricing & Terms" },
			{ index: 3, id: "pa-section-3", title: "Appendix" },
		]);
		expect(bodyOf(html)).toContain(
			'<header class="pa-section-opener" id="pa-section-1"><h2>Executive <em>Summary</em></h2></header>',
		);
		expect(bodyOf(html)).toContain(
			'<blockquote class="pa-callout"><h2>Not a section</h2></blockquote>',
		);
		const titles = Array.from(
			contentsOf(html).matchAll(
				/<a href="#(pa-section-\d+)">([^<]*)<\/a>/g,
			),
			(match) => [match[1], match[2]],
		);
		expect(titles).toEqual([
			["pa-section-1", "Executive Summary"],
			["pa-section-2", "Pricing &amp; Terms"],
			["pa-section-3", "Appendix"],
		]);
		expect(contentsOf(html)).toContain(
			'<p class="pa-eyebrow">Contents</p>',
		);
		// Right after the cover.
		expect(html).toMatch(/<\/section>\n<nav class="pa-contents"/);
	});

	it("leaves the slots empty and marks every opener in the locate pass", () => {
		const { html, sections, warnings } = build(DOC, { pass: LOCATE });

		const slots = contentsOf(html).match(
			/<span class="pa-contents-page">[^<]*<\/span>/g,
		);
		expect(slots).toEqual(
			Array(3).fill('<span class="pa-contents-page"></span>'),
		);
		const markers = Array.from(
			html.matchAll(PAGE_MARKER_PATTERN),
			(match) => Number(match[1]),
		);
		expect(markers).toEqual([1, 2, 3]);
		for (const section of sections) {
			expect(html).toContain(
				`<header class="pa-section-opener" id="${section.id}"><span class="pa-page-marker" aria-hidden="true">${pageMarkerText(section.index)}</span><h2>`,
			);
		}
		expect(warnings).toEqual([]);
	});

	it("prints the page numbers and no markers in the final pass", () => {
		const { html, warnings } = build(DOC, {
			pass: {
				kind: "final",
				pageNumbers: new Map([
					[1, 3],
					[2, 7],
				]),
			},
		});

		expect(
			contentsOf(html).match(
				/<span class="pa-contents-page">[^<]*<\/span>/g,
			),
		).toEqual([
			'<span class="pa-contents-page">3</span>',
			'<span class="pa-contents-page">7</span>',
			'<span class="pa-contents-page"></span>',
		]);
		expect(bodyOf(html)).not.toContain("pa-page-marker");
		expect(Array.from(html.matchAll(PAGE_MARKER_PATTERN))).toEqual([]);
		// Missing numbers are the print step's to report.
		expect(warnings).toEqual([]);
	});

	it("lays both passes out alike: only the markers and the slot text differ", () => {
		const locate = build(DOC, { pass: LOCATE }).html;
		const final = build(DOC, {
			pass: {
				kind: "final",
				pageNumbers: new Map([
					[1, 3],
					[2, 7],
					[3, 12],
				]),
			},
		}).html;

		const normalized = (html: string) =>
			html
				.replace(/<span class="pa-page-marker"[^>]*>[^<]*<\/span>/g, "")
				.replace(
					/<span class="pa-contents-page">[^<]*<\/span>/g,
					'<span class="pa-contents-page"></span>',
				);
		expect(normalized(final)).toBe(normalized(locate));
	});

	it("emits no slots when the page numbers are unknown", () => {
		const { html, warnings } = build(DOC, {
			pass: { kind: "final", pageNumbers: null },
		});

		expect(contentsOf(html)).not.toContain("pa-contents-page");
		expect(contentsOf(html)).not.toContain("pa-contents-leader");
		expect(contentsOf(html).match(/<li>/g)).toHaveLength(3);
		expect(warnings).toEqual([]);
	});

	it("has no contents page without a section", () => {
		const { html, sections } = build("# Title\n\nJust text.\n\n### Small");

		expect(sections).toEqual([]);
		expect(bodyOf(html)).not.toContain("pa-contents");
	});
});

describe("buildThemeHtml: fences", () => {
	it("draws a valid stat tiles block as tiles, its text escaped", () => {
		const { html } = build(
			[
				"```stat-tiles",
				"%% fabric-visual: a1b2c3d4e5f6",
				"Faster onboarding: 40%",
				"Risk: <script>1</script>",
				"```",
			].join("\n"),
		);

		expect(bodyOf(html)).toContain(
			'<dl class="pa-stat-tiles"><div class="pa-stat-tile"><dt class="pa-stat-label">Faster onboarding</dt><dd class="pa-stat-value">40%</dd></div><div class="pa-stat-tile"><dt class="pa-stat-label">Risk</dt><dd class="pa-stat-value">&lt;script&gt;1&lt;/script&gt;</dd></div></dl>',
		);
		expect(bodyOf(html)).not.toContain("fabric-visual");
	});

	it("prints a refused stat tiles block as code, as the page does", () => {
		const body = ["A: 1", "B: 2", "C: 3", "D: 4", "E: 5"].join("\n");
		const { html } = build(`\`\`\`stat-tiles\n${body}\n\`\`\``);

		expect(bodyOf(html)).toContain(
			`<pre><code class="language-stat-tiles">${body}</code></pre>`,
		);
		expect(bodyOf(html)).not.toContain("pa-stat-tiles");
	});

	it("prints a diagram's caption line under its figure, escaped, and never in the drawing's source", () => {
		const svg: ExportDiagram = {
			kind: "svg",
			svg: '<svg viewBox="0 0 10 10"><text>drawn</text></svg>',
			width: 10,
			height: 10,
			png: null,
		};
		const fence = (caption: string) =>
			[
				"```mermaid",
				"%% fabric-visual: k3v9q2m7x1a8c4d6",
				`%% caption: ${caption}`,
				"flowchart LR",
				"  A --> B",
				"```",
			].join("\n");
		const markdown = [
			"## Delivery",
			"",
			fence("Plan <b>for</b> Acme & partners"),
			"",
			fence("Not drawn"),
		].join("\n");
		const prepared = prepareExportMarkdown(markdown);

		expect(prepared.diagramSources).toEqual([
			"%% fabric-visual: k3v9q2m7x1a8c4d6\nflowchart LR\n  A --> B",
			"%% fabric-visual: k3v9q2m7x1a8c4d6\nflowchart LR\n  A --> B",
		]);
		const body = bodyOf(
			build(markdown, {
				diagrams: [
					svg,
					{ kind: "placeholder", caption: "Not available." },
				],
			}).html,
		);
		expect(body).toContain(
			'<figure class="pa-figure pa-diagram"><svg viewBox="0 0 10 10"><text>drawn</text></svg><figcaption class="pa-caption">Plan &lt;b&gt;for&lt;/b&gt; Acme &amp; partners</figcaption></figure>',
		);
		expect(body).toContain(
			'<p class="pa-caption">Not available.</p><figcaption class="pa-caption">Not drawn</figcaption></figure>',
		);
		expect(body).not.toContain("%% caption");
	});

	it("drops citation markers from a diagram's caption, and the caption when nothing else is left", () => {
		const svg: ExportDiagram = {
			kind: "svg",
			svg: '<svg viewBox="0 0 10 10"></svg>',
			width: 10,
			height: 10,
			png: null,
		};
		const fence = (caption: string) =>
			`\`\`\`mermaid\n%% caption: ${caption}\nflowchart LR\n  A --> B\n\`\`\``;
		const body = bodyOf(
			build([fence("Rollout plan [S2]"), "", fence("[S3]")].join("\n"), {
				diagrams: [svg, svg],
			}).html,
		);
		expect(body).toContain(
			'<figcaption class="pa-caption">Rollout plan</figcaption>',
		);
		expect(body).not.toContain("[S");
		expect(body.match(/<figcaption/g)).toHaveLength(1);
	});

	it("prints no caption for a diagram without one", () => {
		const svg: ExportDiagram = {
			kind: "svg",
			svg: '<svg viewBox="0 0 10 10"></svg>',
			width: 10,
			height: 10,
			png: null,
		};
		const body = bodyOf(
			build("```mermaid\nflowchart LR\n  A --> B\n```", {
				diagrams: [svg],
			}).html,
		);
		expect(body).not.toContain("<figcaption");
	});

	it("takes each diagram by its fence, nested ones included", () => {
		const svg = (label: string): ExportDiagram => ({
			kind: "svg",
			svg: `<svg viewBox="0 0 10 10"><text>${label}</text></svg>`,
			width: 10,
			height: 10,
			png: null,
		});
		const markdown = [
			"```mermaid",
			"flowchart LR",
			"  A --> B",
			"```",
			"",
			"- A step",
			"",
			"  ```mermaid",
			"  flowchart LR",
			"    B --> C",
			"  ```",
			"",
			"> ```mermaid",
			"> flowchart LR",
			">   C --> D",
			"> ```",
			"",
			"```mermaid",
			"flowchart LR",
			"  D --> E",
			"```",
		].join("\n");
		const prepared = prepareExportMarkdown(markdown);
		expect(prepared.diagramSources).toHaveLength(4);

		const { html, warnings } = build(markdown, {
			diagrams: [
				svg("first"),
				{ kind: "placeholder", caption: "Diagram <unavailable>" },
				svg("third"),
			],
		});
		const body = bodyOf(html);

		const figures = Array.from(
			body.matchAll(
				/<figure class="pa-figure ([a-z-]+)">(.*?)<\/figure>/g,
			),
			(match) => [match[1], match[2]],
		);
		expect(figures).toEqual([
			["pa-diagram", '<svg viewBox="0 0 10 10"><text>first</text></svg>'],
			[
				"pa-diagram-placeholder",
				'<p class="pa-caption">Diagram &lt;unavailable&gt;</p>',
			],
			["pa-diagram", '<svg viewBox="0 0 10 10"><text>third</text></svg>'],
			[
				"pa-diagram-placeholder",
				'<p class="pa-caption">This diagram could not be drawn for export.</p>',
			],
		]);
		// The blank line before the fence makes the item loose.
		expect(body).toMatch(
			/<li><p>A step<\/p><figure class="pa-figure pa-diagram-placeholder">/,
		);
		expect(body).not.toContain("flowchart");
		// Only the fence the diagram step returned nothing for is counted here.
		expect(warnings).toEqual([{ code: "DIAGRAM_PLACEHOLDER", count: 1 }]);
	});

	it("prints any other fence as escaped code", () => {
		const { html } = build(
			[
				'```js" onclick="x',
				"if (a < b && c) { run('</code>'); }",
				"```",
			].join("\n"),
		);

		expect(bodyOf(html)).toContain(
			"<pre><code>if (a &lt; b &amp;&amp; c) { run(&#39;&lt;/code&gt;&#39;); }</code></pre>",
		);
	});
});

describe("buildThemeHtml: raw HTML that names stored objects", () => {
	const KEY = `document-media/${PROJECT}/${DOCUMENT}/chart.png`;
	const SIGNED = "https://storage.example.com/chart.png?X-Amz-Signature=abc";

	it("draws an uploaded image whose alt and caption hold < and >", () => {
		const { html } = build(
			`<img src="${SIGNED}" alt="Before -> after" data-s3-key="${KEY}" data-caption="1 < 2 &amp; 3 > 2" />`,
			{ images: new Map([[KEY, png]]) },
		);
		const body = bodyOf(html);
		expect(body).toContain('alt="Before -&gt; after"');
		expect(body).toContain("1 &lt; 2 &amp; 3 &gt; 2");
		expect(html).not.toContain("X-Amz-Signature");
		expect(html).not.toContain(KEY);
	});

	it("stops embedding one image placed past the page's image budget, and counts the rest", () => {
		// Half the budget plus a little, as its base64 data URL.
		const large: ExportRaster = {
			mimeType: "image/png",
			bytes: Buffer.alloc(
				Math.ceil((MAX_EMBEDDED_IMAGE_CHARS / 2) * 0.75) + 1024,
			),
			width: 100,
			height: 100,
		};
		const tag = `<img src="${SIGNED}" alt="Large" data-s3-key="${KEY}" />`;
		const { html, warnings } = build([tag, tag, tag].join("\n\n"), {
			images: new Map([[KEY, large]]),
		});
		expect(html.match(/<img src="data:image\/png/g)).toHaveLength(1);
		expect(warnings).toEqual([{ code: "IMAGE_LIMIT", count: 2 }]);
	});

	it("leaves out a refused stored-image tag rather than print its key and signed URL", () => {
		const { html } = build(
			[
				"Before.",
				"",
				`<img src="${SIGNED}" alt="x" data-s3-key="${KEY}" data-s3-key="${KEY}" />`,
				"",
				`Inline <a href="${SIGNED}" data-s3-key="${KEY}">file</a> link.`,
				"",
				"After.",
			].join("\n"),
			{ images: new Map([[KEY, png]]) },
		);
		expect(html).not.toContain("X-Amz-Signature");
		expect(html).not.toContain(KEY);
		expect(bodyOf(html)).toContain("file");
		expect(bodyOf(html)).toContain("After.");
	});

	it("never prints or links an image tag the parser could not read, or one with no key", () => {
		const { html, warnings } = build(
			[
				"Before.",
				"",
				`<img src="${SIGNED}" alt="27" display.png" width="320" data-s3-key="${KEY}" data-caption="Our desk" />`,
				"",
				`<img src="${SIGNED}" alt="Desk" />`,
				"",
				"After.",
			].join("\n"),
		);
		expect(html).toContain("Before.");
		expect(html).toContain("After.");
		expect(html).not.toContain("X-Amz-Signature");
		expect(html).not.toContain("storage.example.com");
		expect(html).not.toContain(KEY);
		expect(warnings).toEqual([]);
	});

	it("never prints or links a stored object's URL written into Main", () => {
		const { html } = build(
			[
				`See ${SIGNED} for the chart.`,
				"",
				`Or [the chart](${SIGNED}) and <https://storage.example.com/${KEY}>.`,
				"",
				`[brief]: https://storage.example.com/${KEY}`,
				"",
				"The [brief][brief] stays as words.",
			].join("\n"),
		);
		expect(html).not.toMatch(/X-Amz|document-media|storage\.example\.com/);
		expect(bodyOf(html)).toContain("for the chart.");
		expect(bodyOf(html)).toContain("the chart");
		expect(bodyOf(html)).toContain("stays as words.");
	});

	it("prints raw HTML less its comments", () => {
		const { html } = build("<!-- draft note --> visible remainder");
		expect(bodyOf(html)).toContain("visible remainder");
		expect(html).not.toContain("draft note");
	});
});

describe("buildThemeHtml: Markdown forms", () => {
	it("prints tables with a header row, cell alignment and wide ones in landscape", () => {
		const { html } = build(
			[
				"| Item | Cost | Note |",
				"| :--- | ---: | :---: |",
				"| A | 1 | x |",
				"| B | 2 | y |",
				"",
				"| 1 | 2 | 3 | 4 | 5 | 6 | 7 |",
				"| - | - | - | - | - | - | - |",
				"| a | b | c | d | e | f | g |",
			].join("\n"),
		);
		const body = bodyOf(html);

		expect(body).toContain(
			'<table class="pa-data-table"><thead><tr><th style="text-align: left">Item</th><th style="text-align: right">Cost</th><th style="text-align: center">Note</th></tr></thead><tbody><tr><td style="text-align: left">A</td>',
		);
		expect(body.match(/<section class="pa-landscape">/g)).toHaveLength(1);
		expect(body).toMatch(
			/<section class="pa-landscape"><table class="pa-data-table"><thead><tr><th>1<\/th>(<th>\d<\/th>){6}<\/tr><\/thead><tbody><tr>(<td>[a-g]<\/td>){7}<\/tr><\/tbody><\/table><\/section>/,
		);
	});

	it("opens a section whose first block is a wide table on that table's landscape page", () => {
		const { html, sections } = build(
			[
				"## Pricing",
				"",
				"Fees by phase.",
				"",
				"## Appendix A: Assumptions",
				"",
				"| 1 | 2 | 3 | 4 | 5 | 6 | 7 |",
				"| - | - | - | - | - | - | - |",
				"| a | b | c | d | e | f | g |",
				"",
				"Start date: TBD",
			].join("\n"),
		);
		const body = bodyOf(html);

		expect(sections.map((section) => section.title)).toEqual([
			"Pricing",
			"Appendix A: Assumptions",
		]);
		expect(body.match(/<section class="pa-landscape">/g)).toHaveLength(1);
		expect(body).toMatch(
			/<section class="pa-landscape"><header class="pa-section-opener" id="pa-section-2"><h2>Appendix A: Assumptions<\/h2><\/header><table class="pa-data-table">.*?<\/table><\/section><p>Start date: TBD<\/p>/,
		);
		// The first section's opener stays in the portrait flow.
		expect(body).toMatch(
			/<header class="pa-section-opener" id="pa-section-1"><h2>Pricing<\/h2><\/header><p>Fees by phase\.<\/p>/,
		);
	});

	it("prints lists, task items, callouts, code, rules and inline forms", () => {
		const { html } = build(
			[
				"3. third",
				"4. fourth",
				"",
				"- [x] done",
				"- [ ] open",
				"",
				// Another bullet character starts another list.
				"* loose one",
				"",
				"* loose two",
				"",
				"> **Note:** _careful_ ~~old~~ `code`",
				"",
				"---",
				"",
				"Line one  ",
				"line two",
			].join("\n"),
		);
		const body = bodyOf(html);

		expect(body).toContain(
			'<ol start="3"><li>third</li><li>fourth</li></ol>',
		);
		expect(body).toContain(
			'<ul class="contains-task-list"><li><input type="checkbox" disabled checked> done</li><li><input type="checkbox" disabled> open</li></ul>',
		);
		expect(body).toContain(
			"<ul><li><p>loose one</p></li><li><p>loose two</p></li></ul>",
		);
		expect(body).toContain(
			'<blockquote class="pa-callout"><p><strong>Note:</strong> <em>careful</em> <del>old</del> <code>code</code></p></blockquote>',
		);
		expect(body).toContain("<hr>");
		expect(body).toContain("<p>Line one<br>line two</p>");
	});

	it("prints markup nested too deep for the walk as its plain text", () => {
		const stars = "*".repeat(5000);
		const { html } = build(
			`${stars}deep <b>text</b>${stars}\n\n${"> ".repeat(200)}quoted`,
		);
		const body = bodyOf(html);

		// Plain text only: raw HTML down there is left out whole.
		expect(body).toContain("deep text");
		expect(body).toContain("quoted");
		expect(body).not.toMatch(/<b>|&lt;b&gt;/);
	});

	it("numbers footnotes by first reference and lists them at the end", () => {
		const { html } = build(
			[
				"Claim one[^b] and claim two[^a], again[^b].",
				"",
				"[^a]: Note <a>.",
				"[^b]: Note b, see[^a].",
				"[^unused]: Never referenced.",
			].join("\n"),
		);
		const body = bodyOf(html);

		expect(body).toContain(
			'<p>Claim one<sup><a href="#pa-fn-1">1</a></sup> and claim two<sup><a href="#pa-fn-2">2</a></sup>, again<sup><a href="#pa-fn-1">1</a></sup>.</p>',
		);
		expect(body).toContain(
			'<section class="pa-footnotes" aria-label="Footnotes"><hr><ol><li id="pa-fn-1"><p>Note b, see<sup><a href="#pa-fn-2">2</a></sup>.</p></li><li id="pa-fn-2"><p>Note &lt;a&gt;.</p></li></ol></section>',
		);
		expect(body).not.toContain("Never referenced");
	});
});
