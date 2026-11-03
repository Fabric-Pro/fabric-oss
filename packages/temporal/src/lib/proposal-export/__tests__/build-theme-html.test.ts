import {
	PRINT_FIGURE_MAX_HEIGHT_PX,
	PRINT_FIGURE_UNDER_OPENER_MAX_HEIGHT_PX,
	printFigureUnderOpenerMaxHeightPx,
} from "@repo/utils/proposal-artifact/proposal-theme";
import { buildProposalThemeTokens } from "@repo/utils/proposal-artifact/theme-tokens";
import sharp from "sharp";
import { beforeAll, describe, expect, it } from "vitest";
import { type AppendixLabels, appendixLabels } from "../build-cover-html";
import {
	type BuildThemeHtmlInput,
	buildThemeHtml,
	MAX_EMBEDDED_IMAGE_CHARS,
	PAGE_MARKER_PATTERN,
	pageMarkerText,
	printedBlockFacts,
	printFigureMaxHeight,
	printFigureMaxHeights,
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

	it("prints each role in its committed face, whatever the brand names", () => {
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
		// A brand-font organization prints Poppins for display.
		expect(style).toContain("--pa-font-display: &quot;Poppins&quot;");
		expect(style).toContain("--pa-font-body: &quot;Inter&quot;");
		expect(style).toContain("--pa-font-mono: &quot;JetBrains Mono&quot;");
	});

	it("embeds Poppins, Inter and JetBrains Mono from committed files, each with its own MIME type and format", () => {
		const { html } = build("Text.");
		const faces = [
			...html.matchAll(
				/@font-face \{\n\tfont-family: "([^"]+)";\n\tfont-style: normal;\n\tfont-weight: (\d+);\n\tfont-display: block;\n\tsrc: url\(data:([^;]+);base64,([A-Za-z0-9+/=]+)\) format\("([^"]+)"\);\n\}/g,
			),
		].map(([, family, weight, mime, data, format]) => ({
			face: `${family} ${weight}`,
			mime,
			format,
			// The file's own signature: woff2 or a TrueType outline font.
			signature: Buffer.from(data ?? "", "base64")
				.subarray(0, 4)
				.toString("hex"),
		}));

		const woff2 = {
			mime: "font/woff2",
			format: "woff2",
			signature: "774f4632",
		};
		const ttf = {
			mime: "font/ttf",
			format: "truetype",
			signature: "00010000",
		};
		expect(faces).toEqual([
			{ face: "Poppins 700", ...ttf },
			{ face: "Inter 400", ...woff2 },
			{ face: "Inter 500", ...woff2 },
			{ face: "Inter 600", ...woff2 },
			{ face: "Inter 700", ...woff2 },
			{ face: "Inter 800", ...woff2 },
			{ face: "JetBrains Mono 400", ...woff2 },
			{ face: "JetBrains Mono 500", ...woff2 },
		]);
		expect(html.match(/@font-face/g)).toHaveLength(faces.length);
		expect(html).not.toMatch(/url\(\s*["']?(https?:)?\/\//i);
	});

	it("keeps the margin boxes on the literal Inter stack", () => {
		const { html } = build("Text.");
		const footer = /@bottom-left \{[^}]*font-family: ([^;]+);/.exec(html);

		expect(footer?.[1]).toBe('"Inter", ui-sans-serif, sans-serif');
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
		// A footer only: no running header repeats the title.
		expect(build("x").html).not.toMatch(/@top-left \{[^}]*content: "/);
	});

	it("cuts a long title at a word so the footer stays on one line", () => {
		const footer = (html: string) =>
			/@bottom-left \{[^}]*content: "([^"]*)"/.exec(html)?.[1];
		const title =
			"A field service modernisation pilot for Example Harbor Co regional crews";

		expect(footer(build("Text.", { title }).html)).toBe(
			"Example Org · A field service modernisation pilot for Example Harbor Co… · October 15, 2026 · Confidential",
		);
		const exact = "x".repeat(60);
		expect(footer(build("Text.", { title: exact }).html)).toBe(
			`Example Org · ${exact} · October 15, 2026 · Confidential`,
		);
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
		// The preamble's paragraph is the cover's lead, scrubbed as well.
		expect(body).toContain(
			'<p class="pa-cover-lead">Our approach cuts onboarding time.</p>',
		);
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

		// Main has no section, so its first paragraph stays in the body.
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
		// Two logos and the uploaded image; the hero is a background.
		expect(sources).toBe(3);
		const body = startTags(html).find((tag) => tag.name === "body");
		expect(attribute(body?.attributes ?? "", "style")).toMatch(
			/^--pa-hero-image: url\(data:image\/jpeg;base64,[A-Za-z0-9+/=]+\)$/,
		);
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
	/** What follows the cover: the contents page and the body. */
	const afterCover = (html: string) => {
		const body = bodyOf(html);
		return body.slice(body.indexOf("</section>") + 10);
	};
	const PARTIES =
		'<div class="pa-cover-parties"><dl class="pa-cover-party-for"><dt>Prepared for</dt><dd>Example Client</dd></dl><div class="pa-cover-party-by"><dl><dt>Prepared by</dt><dd>Example Org</dd></dl><p class="pa-cover-date">October 15, 2026 · Confidential</p></div></div>';
	const measured = (
		raster: ExportRaster,
		tone: Pick<ExportRaster, "luminance" | "opaque">,
	): ExportRaster => ({ ...raster, ...tone });

	it("opens the body, block-level, with the data-held fields only when Main has no preamble", () => {
		const { html } = build("## Overview\n\nText.");
		const cover = coverOf(html);

		expect(bodyOf(html)).toMatch(
			/^<body data-proposal-theme="print">\n<section class="pa-cover">/,
		);
		expect(cover).toBe(
			`<section class="pa-cover"><div class="pa-cover-body"><p class="pa-eyebrow">Proposal</p><h1 class="pa-cover-title">Example Proposal</h1></div>${PARTIES}</section>`,
		);
		expect(cover).not.toContain("pa-cover-lead");
		expect(cover).not.toContain("pa-cover-figures");
		expect(cover).not.toContain("pa-cover-brands");
	});

	it("holds every field in order: hero, brands, eyebrow, title, lead, figures, parties", () => {
		const dark = measured(png, { luminance: 0.04, opaque: false });
		const light = measured(png, { luminance: 0.93, opaque: false });
		const { html } = build(
			[
				"A short lead for the cover.",
				"",
				"```stat-tiles",
				"Weeks to launch: 12",
				"Engineers: 3",
				"Fixed fee: $180,000",
				"```",
				"",
				"## Overview",
				"",
				"Text.",
			].join("\n"),
			{
				tokens: exportTokens({
					proposerLogo: light,
					recipientLogo: dark,
					hero: jpeg,
				}),
			},
		);
		const data = (raster: ExportRaster) =>
			`data:${raster.mimeType};base64,${raster.bytes.toString("base64")}`;

		expect(coverOf(html)).toBe(
			[
				'<section class="pa-cover">',
				'<div class="pa-cover-hero"></div>',
				'<div class="pa-cover-brands">',
				`<img class="pa-cover-logo pa-cover-logo-proposer" src="${data(light)}" alt="Example Org logo">`,
				`<img class="pa-cover-logo pa-cover-logo-recipient pa-cover-logo-plate" src="${data(dark)}" alt="Example Client logo">`,
				"</div>",
				'<div class="pa-cover-body">',
				'<p class="pa-eyebrow">Proposal</p>',
				'<h1 class="pa-cover-title">Example Proposal</h1>',
				'<p class="pa-cover-lead">A short lead for the cover.</p>',
				'<dl class="pa-cover-figures">',
				"<div><dt>Weeks to launch</dt><dd>12</dd></div>",
				"<div><dt>Engineers</dt><dd>3</dd></div>",
				"<div><dt>Fixed fee</dt><dd>$180,000</dd></div>",
				"</dl>",
				"</div>",
				PARTIES,
				"</section>",
			].join(""),
		);
	});

	it("sets a dark or opaque logo on the plate and a light or unmeasured one straight on the ink", () => {
		const plated = (raster: ExportRaster) =>
			coverOf(
				build("Text.", {
					tokens: exportTokens({ proposerLogo: raster }),
				}).html,
			).includes("pa-cover-logo-plate");

		expect(plated(measured(png, { luminance: 0.02, opaque: false }))).toBe(
			true,
		);
		expect(plated(measured(png, { luminance: 0.44, opaque: false }))).toBe(
			true,
		);
		expect(plated(measured(png, { luminance: 0.45, opaque: false }))).toBe(
			false,
		);
		expect(plated(measured(png, { luminance: 0.97, opaque: false }))).toBe(
			false,
		);
		// An opaque image's own edge would meet the ink, however light it is.
		expect(plated(measured(jpeg, { luminance: 0.97, opaque: true }))).toBe(
			true,
		);
		// Nothing opaque to measure, or not measured at all.
		expect(plated(measured(png, { opaque: false }))).toBe(false);
		expect(plated(png)).toBe(false);
	});

	it("draws one logo alone on its own side, and no brands row without a logo", () => {
		const recipientOnly = coverOf(
			build("Text.", { tokens: exportTokens({ recipientLogo: png }) })
				.html,
		);
		expect(recipientOnly).toMatch(
			/<div class="pa-cover-brands"><img class="pa-cover-logo pa-cover-logo-recipient" [^>]*><\/div>/,
		);
		expect(recipientOnly).not.toContain("pa-cover-logo-proposer");

		const proposerOnly = coverOf(
			build("Text.", { tokens: exportTokens({ proposerLogo: png }) })
				.html,
		);
		expect(proposerOnly).toMatch(
			/<div class="pa-cover-brands"><img class="pa-cover-logo pa-cover-logo-proposer" [^>]*><\/div>/,
		);

		expect(coverOf(build("Text.").html)).not.toContain("pa-cover-brands");
	});

	it("leaves out a missing party, keeps Prepared by in its column, and always prints the date line", () => {
		const noRecipient = coverOf(
			build("Text.", { tokens: exportTokens({ recipientName: "  " }) })
				.html,
		);
		expect(noRecipient).not.toContain("Prepared for");
		expect(noRecipient).toContain(
			'<div class="pa-cover-parties"><div class="pa-cover-party-by"><dl><dt>Prepared by</dt><dd>Example Org</dd></dl><p class="pa-cover-date">October 15, 2026 · Confidential</p></div></div>',
		);

		const nobody = coverOf(
			build("Text.", {
				dateLabel: " ",
				tokens: exportTokens({
					recipientName: null,
					proposerName: null,
				}),
			}).html,
		);
		expect(nobody).not.toContain("Prepared");
		expect(nobody).toContain(
			'<div class="pa-cover-parties"><div class="pa-cover-party-by"><p class="pa-cover-date">Confidential</p></div></div>',
		);
	});

	it("draws the hero as a background only when there is one, its bytes written once on the body", () => {
		const bare = build("Text.").html;
		expect(coverOf(bare)).not.toContain("pa-cover-hero");
		expect(bodyOf(bare)).not.toContain("--pa-hero-image");

		const { html } = build("Text.\n\n## One\n\n## Two", {
			tokens: exportTokens({ hero: jpeg }),
		});
		expect(coverOf(html)).toMatch(
			/^<section class="pa-cover"><div class="pa-cover-hero"><\/div><div class="pa-cover-body">/,
		);
		expect(bodyOf(html)).toMatch(
			/^<body data-proposal-theme="print" style="--pa-hero-image: url\(data:image\/jpeg;base64,[A-Za-z0-9+/=]+\)">/,
		);
		expect(html.match(/data:image\/jpeg;base64,/g)).toHaveLength(1);
	});

	it("writes the hero's small copy for the openers beside the hero, once", () => {
		const { html } = build("Text.\n\n## One\n\n## Two", {
			tokens: exportTokens({ hero: { ...jpeg, openerCopy: png } }),
		});
		expect(bodyOf(html)).toMatch(
			/^<body data-proposal-theme="print" style="--pa-hero-image: url\(data:image\/jpeg;base64,[A-Za-z0-9+/=]+\); --pa-hero-opener-image: url\(data:image\/png;base64,[A-Za-z0-9+/=]+\)">/,
		);
		expect(html.match(/--pa-hero-opener-image: url\(data:/g)).toHaveLength(
			1,
		);
	});

	it("veils the hero by its measured bright end, and a hero without one as though it were white", () => {
		const veil = (hero: ExportRaster) =>
			Number(
				/--pa-hero-veil: ([0-9.]+)/.exec(
					build("Text.", { tokens: exportTokens({ hero }) }).html,
				)?.[1],
			);
		const unmeasured = veil(jpeg);

		expect(veil({ ...jpeg, luminance: 0.02 })).toBeLessThan(0.35);
		expect(veil({ ...jpeg, luminance: 1 })).toBe(unmeasured);
		expect(unmeasured).toBeGreaterThan(0.5);
	});

	it("takes a block of three tiles before the first section as the key figures, and leaves it out of the body", () => {
		const { html } = build(
			[
				"```stat-tiles",
				"%% fabric-visual: a1b2c3d4e5f6",
				"Weeks: 12",
				"Engineers: 3",
				"Fee: $180,000",
				"```",
				"",
				"## Overview",
				"",
				"Text.",
			].join("\n"),
		);

		expect(coverOf(html)).toContain(
			'<dl class="pa-cover-figures"><div><dt>Weeks</dt><dd>12</dd></div><div><dt>Engineers</dt><dd>3</dd></div><div><dt>Fee</dt><dd>$180,000</dd></div></dl>',
		);
		expect(afterCover(html)).not.toContain("pa-stat-tiles");
		expect(afterCover(html)).not.toContain("Engineers");
		expect(html).not.toContain("fabric-visual");
	});

	it("takes one or two tiles as they are", () => {
		const { html } = build(
			"```stat-tiles\nWeeks: 12\nFee: $90,000\n```\n\n## Overview",
		);

		expect(coverOf(html)).toContain(
			'<dl class="pa-cover-figures"><div><dt>Weeks</dt><dd>12</dd></div><div><dt>Fee</dt><dd>$90,000</dd></div></dl>',
		);
	});

	it("leaves a block of four tiles whole in the body, and the cover without figures", () => {
		const { html } = build(
			[
				"```stat-tiles",
				"A: 1",
				"B: 2",
				"C: 3",
				"D: 4",
				"```",
				"",
				"## Overview",
			].join("\n"),
		);

		expect(coverOf(html)).not.toContain("pa-cover-figures");
		expect(afterCover(html).match(/class="pa-stat-tile"/g)).toHaveLength(4);
	});

	it("takes only the first tiles block, and none after the first section or that the parser refuses", () => {
		const refusedFirst = build(
			[
				"```stat-tiles",
				"not a tile",
				"```",
				"",
				"```stat-tiles",
				"A: 1",
				"```",
				"",
				"## Overview",
			].join("\n"),
		).html;
		expect(coverOf(refusedFirst)).not.toContain("pa-cover-figures");
		expect(afterCover(refusedFirst)).toContain(
			'<pre><code class="language-stat-tiles">not a tile</code></pre>',
		);
		expect(afterCover(refusedFirst)).toContain(
			'<dl class="pa-stat-tiles">',
		);

		const inSection = build(
			["## Results", "", "```stat-tiles", "A: 1", "```"].join("\n"),
		).html;
		expect(coverOf(inSection)).not.toContain("pa-cover-figures");
		expect(afterCover(inSection)).toContain('<dl class="pa-stat-tiles">');
	});

	it("takes the first paragraph before the first section as the lead, and leaves it out of the body", () => {
		const { html } = build(
			[
				"# Example Proposal",
				"",
				"The **short** lead, with [a link](https://example.com/lead).",
				"",
				"A second paragraph stays.",
				"",
				"## Overview",
				"",
				"Section text stays.",
			].join("\n"),
		);

		expect(coverOf(html)).toContain(
			'<p class="pa-cover-lead">The <strong>short</strong> lead, with <a href="https://example.com/lead">a link</a>.</p>',
		);
		expect(afterCover(html)).not.toContain("short");
		expect(afterCover(html)).toContain("<p>A second paragraph stays.</p>");
		expect(afterCover(html)).toContain("<p>Section text stays.</p>");
	});

	it("numbers a footnote the lead references before the body's own", () => {
		const { html } = build(
			[
				"Lead claim[^a].",
				"",
				"## Overview",
				"",
				"Body claim[^b].",
				"",
				"[^a]: Note a.",
				"[^b]: Note b.",
			].join("\n"),
		);

		expect(coverOf(html)).toContain(
			'<p class="pa-cover-lead">Lead claim<sup><a href="#pa-fn-1">1</a></sup>.</p>',
		);
		expect(afterCover(html)).toContain(
			'<p>Body claim<sup><a href="#pa-fn-2">2</a></sup>.</p>',
		);
		expect(afterCover(html)).toContain(
			'<li id="pa-fn-1"><p>Note a.</p></li><li id="pa-fn-2"><p>Note b.</p></li>',
		);
	});

	it("leaves a first paragraph over 320 characters in the body, and the cover without a lead", () => {
		const exact = "x".repeat(320);
		expect(coverOf(build(`${exact}\n\n## Overview`).html)).toContain(
			`<p class="pa-cover-lead">${exact}</p>`,
		);

		const long =
			`${"Example sentence of the preamble. ".repeat(15)}`.trim();
		expect(Array.from(long).length).toBeGreaterThan(320);
		const { html } = build(
			`${long}\n\nA short second paragraph.\n\n## Overview`,
		);

		expect(coverOf(html)).not.toContain("pa-cover-lead");
		expect(afterCover(html)).toContain(`<p>${long}</p>`);
		// Only the first paragraph is ever the lead.
		expect(afterCover(html)).toContain("<p>A short second paragraph.</p>");
	});

	it("never takes a paragraph after the first section, or an image, as the lead", () => {
		expect(coverOf(build("## Overview\n\nShort text.").html)).not.toContain(
			"pa-cover-lead",
		);

		// A paragraph holding an uploaded image, alone or beside its text.
		for (const markdown of [
			`Chart: ${imageTag(mediaKey("chart.png"))}`,
			"Remote ![chart](https://example.com/chart.png) image.",
		]) {
			const { html } = build(`${markdown}\n\n## Overview`, {
				images: new Map([[mediaKey("chart.png"), png]]),
			});
			expect(coverOf(html)).not.toContain("pa-cover-lead");
			expect(afterCover(html)).toMatch(
				/<p>(Chart: <img|Remote {2}image)/,
			);
		}
	});

	it("lifts nothing from a Main without sections: its first paragraph and tiles stay in the body", () => {
		const { html } = build(
			[
				"# Overview",
				"",
				"A short opening paragraph.",
				"",
				"```stat-tiles",
				"Weeks: 12",
				"```",
				"",
				"# Pricing",
				"",
				"Fees by phase.",
			].join("\n"),
		);

		expect(coverOf(html)).not.toContain("pa-cover-lead");
		expect(coverOf(html)).not.toContain("pa-cover-figures");
		expect(afterCover(html)).toContain("<p>A short opening paragraph.</p>");
		expect(afterCover(html)).toContain('<dl class="pa-stat-tiles">');
	});

	it("stops looking for the preamble at the first heading of any depth, past one opening H1", () => {
		const { html } = build(
			[
				"# Example Proposal",
				"",
				"### Background",
				"",
				"A short paragraph under a subheading.",
				"",
				"```stat-tiles",
				"Weeks: 12",
				"```",
				"",
				"## Overview",
				"",
				"Text.",
			].join("\n"),
		);

		expect(coverOf(html)).not.toContain("pa-cover-lead");
		expect(coverOf(html)).not.toContain("pa-cover-figures");
		expect(afterCover(html)).toContain(
			"<p>A short paragraph under a subheading.</p>",
		);
		expect(afterCover(html)).toContain('<dl class="pa-stat-tiles">');
	});

	it("leaves a first paragraph that introduces the next block in the body, with that block", () => {
		for (const [lead, next] of [
			["The phases are as follows:", "Planned work."],
			["The phases are", "- Discovery\n- Build"],
			["The fees are", "| Phase | Fee |\n| --- | --- |\n| Build | $9 |"],
			["The flow is", "```mermaid\nflowchart LR\n  A --> B\n```"],
		]) {
			const { html } = build(`${lead}\n\n${next}\n\n## Overview`);

			expect(coverOf(html)).not.toContain("pa-cover-lead");
			expect(afterCover(html)).toContain(`<p>${lead}</p>`);
		}

		// The tiles the cover takes along strand nothing.
		const { html } = build(
			"The short lead.\n\n```stat-tiles\nWeeks: 12\n```\n\n## Overview",
		);
		expect(coverOf(html)).toContain(
			'<p class="pa-cover-lead">The short lead.</p>',
		);
	});

	it("escapes the title, the lead, the figures and the names", () => {
		const { html } = build(
			[
				'Lead <b>bold</b> & "quoted".',
				"",
				"```stat-tiles",
				"Risk <i>: <script>1</script>",
				"```",
				"",
				"## Overview",
			].join("\n"),
			{
				title: 'Q3 <Plan> & "More"',
				tokens: exportTokens({ proposerName: "<b>Example</b> Org" }),
			},
		);
		const cover = coverOf(html);

		expect(html).toContain(
			"<title>Q3 &lt;Plan&gt; &amp; &quot;More&quot;</title>",
		);
		expect(cover).toContain(
			'<h1 class="pa-cover-title">Q3 &lt;Plan&gt; &amp; &quot;More&quot;</h1>',
		);
		expect(cover).toContain(
			'<p class="pa-cover-lead">Lead &lt;b&gt;bold&lt;/b&gt; &amp; &quot;quoted&quot;.</p>',
		);
		expect(cover).toContain(
			"<div><dt>Risk &lt;i&gt;</dt><dd>&lt;script&gt;1&lt;/script&gt;</dd></div>",
		);
		expect(cover).toContain("<dd>&lt;b&gt;Example&lt;/b&gt; Org</dd>");
		expect(cover).not.toMatch(/<(b|i|script)>/);
	});

	const footerOf = (html: string) =>
		/@bottom-left \{[^}]*content: "([^"]*)"/.exec(html)?.[1];
	const GENERATED = [
		"# Generated Title",
		"",
		"## 1. Intro",
		"",
		"Text.",
	].join("\n");

	it("prints Main's leading H1 as the title on the cover, the contents page, the footer and the page title, and leaves it out of the body", () => {
		const { html } = build(GENERATED);

		expect(coverOf(html)).toContain(
			'<h1 class="pa-cover-title">Generated Title</h1>',
		);
		expect(afterCover(html)).toContain(
			'<p class="pa-eyebrow">Generated Title</p><p class="pa-contents-title">Contents</p>',
		);
		expect(footerOf(html)).toBe(
			"Example Org · Generated Title · October 15, 2026 · Confidential",
		);
		expect(html).toContain("<title>Generated Title</title>");
		// No page holds the H1 alone: the body has none.
		expect(afterCover(html)).not.toContain("<h1");
		expect(afterCover(html)).toContain(
			'<header class="pa-section-opener" id="pa-section-1"><h2>1. Intro</h2></header><p>Text.</p>',
		);
	});

	it("keeps the H1 as the title when the record was renamed after it was written", () => {
		const { html } = build(GENERATED, { title: "Renamed Record" });

		expect(coverOf(html)).toContain(
			'<h1 class="pa-cover-title">Generated Title</h1>',
		);
		expect(footerOf(html)).toBe(
			"Example Org · Generated Title · October 15, 2026 · Confidential",
		);
		expect(html).toContain("<title>Generated Title</title>");
		// The record's name is the download's (the export names the file),
		// never the page's.
		expect(html).not.toContain("Renamed Record");
	});

	it("leaves an H1 in the body, under the record's title, when Main has no sections, the H1 is not first, or it has no text", () => {
		const recordTitled = (markdown: string, images = new Map()) => {
			const { html } = build(markdown, { images });
			expect({ markdown, cover: coverOf(html) }).toEqual({
				markdown,
				cover: expect.stringContaining(
					'<h1 class="pa-cover-title">Example Proposal</h1>',
				),
			});
			expect(html).toContain("<title>Example Proposal</title>");
			return afterCover(html);
		};

		// Main without sections prints whole, as written.
		expect(
			recordTitled("# Generated Title\n\nText.\n\n### Small"),
		).toContain("<h1>Generated Title</h1>");
		// Only an H1 that opens Main is its title.
		expect(
			recordTitled("Intro.\n\n# Generated Title\n\n## Overview"),
		).toContain("<h1>Generated Title</h1>");
		// An H1 of an image alone has no text to be a title.
		expect(
			recordTitled(
				`# ${imageTag(mediaKey("logo.png"))}\n\n## Overview`,
				new Map([[mediaKey("logo.png"), png]]),
			),
		).toMatch(
			/<h1><img src="data:image\/png;base64,[^"]+" alt="Example chart"[^>]*><\/h1>/,
		);
	});

	it("escapes the H1 as a title", () => {
		const { html } = build('# Fees < costs & "value"\n\n## Overview');

		expect(coverOf(html)).toContain(
			'<h1 class="pa-cover-title">Fees &lt; costs &amp; &quot;value&quot;</h1>',
		);
		expect(html).toContain(
			"<title>Fees &lt; costs &amp; &quot;value&quot;</title>",
		);
		expect(afterCover(html)).toContain(
			'<p class="pa-eyebrow">Fees &lt; costs &amp; &quot;value&quot;</p>',
		);
		expect(bodyOf(html)).not.toContain("Fees < costs");
	});

	it("still lifts the lead and the key figures after the H1", () => {
		const { html } = build(
			[
				"# Generated Title",
				"",
				"A short lead for the cover.",
				"",
				"```stat-tiles",
				"Weeks: 12",
				"```",
				"",
				"## Overview",
				"",
				"Text.",
			].join("\n"),
		);

		expect(coverOf(html)).toContain(
			'<h1 class="pa-cover-title">Generated Title</h1><p class="pa-cover-lead">A short lead for the cover.</p><dl class="pa-cover-figures"><div><dt>Weeks</dt><dd>12</dd></div></dl>',
		);
		expect(afterCover(html)).not.toContain("A short lead");
		expect(afterCover(html)).not.toContain("pa-stat-tiles");
		expect(afterCover(html)).not.toContain("<h1");
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
		// The document's title as the eyebrow, over a "Contents" heading that
		// is not a heading element (the heading rules would draw it as a card).
		expect(contentsOf(html)).toContain(
			`<p class="pa-eyebrow">${TITLE}</p><p class="pa-contents-title">Contents</p>`,
		);
		expect(contentsOf(html)).not.toMatch(/<h[1-6]/);
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
			// The bare "Appendix" heading opens an appendix.
			const opener =
				section.title === "Appendix"
					? `<header class="pa-section-opener pa-appendix" id="${section.id}" data-label="Appendix">`
					: `<header class="pa-section-opener" id="${section.id}">`;
			expect(html).toContain(
				`${opener}<span class="pa-page-marker" aria-hidden="true">${pageMarkerText(section.index)}</span><h2>`,
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
		expect(contentsOf(html).match(/<li[ >]/g)).toHaveLength(3);
		expect(warnings).toEqual([]);
	});

	it("lists a section without the number typed at the start of its heading", () => {
		const titles = (headings: string[]) =>
			Array.from(
				contentsOf(
					build(
						headings.map((heading) => `## ${heading}`).join("\n\n"),
					).html,
				).matchAll(/<a href="#pa-section-\d+">([^<]*)<\/a>/g),
				(match) => match[1],
			);

		expect(
			titles([
				"1. Executive Summary",
				"2) Scope",
				"12: Pricing",
				"2024 roadmap",
				"10x growth",
				"123. Too many digits",
				"3.",
			]),
		).toEqual([
			"Executive Summary",
			"Scope",
			"Pricing",
			"2024 roadmap",
			"10x growth",
			"123. Too many digits",
			"3.",
		]);
		// The opener keeps the heading as typed, beside its "Section n".
		expect(bodyOf(build("## 1. Executive Summary").html)).toContain(
			"<h2>1. Executive Summary</h2>",
		);
	});

	it("takes a short emphasised paragraph after a heading as the opener's subtitle, once", () => {
		const subtitle = "A pilot in two regions, live in twelve weeks.";
		const { html } = build(`## Overview\n\n*${subtitle}*\n\nBody text.`);
		const body = bodyOf(html);

		expect(body).toContain(
			`<header class="pa-section-opener" id="pa-section-1"><h2>Overview</h2><p>${subtitle}</p></header><p>Body text.</p>`,
		);
		expect(body.split(subtitle)).toHaveLength(2);

		const limit = "x".repeat(200);
		expect(bodyOf(build(`## Overview\n\n_${limit}_`).html)).toContain(
			`<h2>Overview</h2><p>${limit}</p></header>`,
		);
	});

	it("leaves a mixed or long paragraph after a heading in the body", () => {
		for (const paragraph of [
			"*Emphasis* and more text.",
			"**Bold only.**",
			"*One* *two*",
			`*${"x".repeat(201)}*`,
		]) {
			const body = bodyOf(build(`## Overview\n\n${paragraph}`).html);
			expect({ paragraph, opener: body }).toEqual({
				paragraph,
				opener: expect.stringContaining(
					'<header class="pa-section-opener" id="pa-section-1"><h2>Overview</h2></header><p>',
				),
			});
		}
	});

	it("opens a landscape section after its subtitle", () => {
		const body = bodyOf(
			build(
				[
					"## Appendix",
					"",
					"*Every requirement and where it is met.*",
					"",
					"| 1 | 2 | 3 | 4 | 5 | 6 | 7 |",
					"| - | - | - | - | - | - | - |",
					"| a | b | c | d | e | f | g |",
				].join("\n"),
			).html,
		);

		expect(body).toMatch(
			/<section class="pa-landscape"><header class="pa-section-opener pa-appendix" id="pa-section-1" data-label="Appendix"><h2>Appendix<\/h2><p>Every requirement and where it is met\.<\/p><\/header><table /,
		);
	});

	it("puts the room an opener needs before every opener but the first and one that opens a landscape page, in both passes", () => {
		const markdown = [
			"## One",
			"",
			"Text.",
			"",
			"## Two",
			"",
			"*A subtitle.*",
			"",
			"Text.",
			"",
			"## Wide",
			"",
			"| 1 | 2 | 3 | 4 | 5 | 6 | 7 |",
			"| - | - | - | - | - | - | - |",
			"| a | b | c | d | e | f | g |",
			"",
			"## Three",
			"",
			"## Empty wide",
			"",
			"|  |  |  |  |  |  |  |",
			"| - | - | - | - | - | - | - |",
		].join("\n");
		const room = '<div class="pa-opener-room" aria-hidden="true"></div>';
		const opener = (index: number) =>
			`<header class="pa-section-opener" id="pa-section-${index}">`;

		for (const pass of [LOCATE, FINAL]) {
			const body = bodyOf(build(markdown, { pass }).html);

			// Right after the contents page, with nothing before it.
			expect(body).toContain(`</nav>\n${opener(1)}`);
			expect(body).toContain(`<p>Text.</p>${room}${opener(2)}`);
			// The landscape page is its own break: no room before it, and the
			// opener after it gets one like any other.
			expect(body).toContain(
				`<p>Text.</p><section class="pa-landscape">${opener(3)}`,
			);
			expect(body).toContain(`</table></section>${room}${opener(4)}`);
			// A wide table with nothing to print leaves its opener portrait.
			expect(body).toContain(`</header>${room}${opener(5)}`);
			expect(body.split(room)).toHaveLength(4);
		}
	});

	it("draws the brand graphic in every opener only when there is a hero, above which the marker sits", () => {
		const graphic =
			'<div class="pa-section-graphic" aria-hidden="true"></div>';
		expect(build("## One\n\n## Two").html).not.toContain(graphic);

		const { html } = build("## One\n\n## Two", {
			tokens: exportTokens({ hero: jpeg }),
			pass: LOCATE,
		});
		expect(bodyOf(html)).toContain(
			`<header class="pa-section-opener" id="pa-section-1">${graphic}<span class="pa-page-marker" aria-hidden="true">${pageMarkerText(1)}</span><h2>One</h2></header>`,
		);
		expect(html.split(graphic)).toHaveLength(3);
	});

	it("has no contents page without a section", () => {
		const { html, sections } = build("# Title\n\nJust text.\n\n### Small");

		expect(sections).toEqual([]);
		expect(bodyOf(html)).not.toContain("pa-contents");
	});

	it("reads an appendix's label from its heading, and nothing from any other heading", () => {
		const labelled = (contents: string): AppendixLabels => ({
			opener: `Appendix ${contents}`,
			contents,
		});
		const unlabelled: AppendixLabels = { opener: "Appendix", contents: "" };

		expect(appendixLabels("Appendix A · Sources")).toEqual(labelled("A"));
		expect(appendixLabels("12. Appendix B: Data")).toEqual(labelled("B"));
		expect(appendixLabels("Anhang C")).toEqual(labelled("C"));
		expect(appendixLabels("Appendix 1")).toEqual(labelled("1"));
		expect(appendixLabels("Appendix II")).toEqual(labelled("II"));
		expect(appendixLabels("Appendix IV: Rates")).toEqual(labelled("IV"));
		expect(appendixLabels("Appendix I")).toEqual(labelled("I"));
		for (const heading of [
			"5 Appendix",
			"Appendix: A note",
			"Appendix",
			"APPENDIX",
			"Appendix Overview",
			"Appendix 123",
			"Appendix a",
		]) {
			expect({ heading, labels: appendixLabels(heading) }).toEqual({
				heading,
				labels: unlabelled,
			});
		}
		for (const heading of [
			"Appendices overview",
			"Appendixes",
			"Appendix-based pricing",
			"Our appendix",
			"Pricing",
			"123. Appendix A",
		]) {
			expect({ heading, labels: appendixLabels(heading) }).toEqual({
				heading,
				labels: null,
			});
		}
	});

	it("labels an appendix's opener and contents entry in place of a number, and lists the sections after it as before", () => {
		const doc = [
			"## Overview",
			"",
			"## Appendix A · Sources",
			"",
			"## Pricing",
			"",
			"## 12. Appendix B: Data",
			"",
			"## Appendix",
		].join("\n");
		const { html, sections } = build(doc, { pass: LOCATE });
		const body = bodyOf(html);

		// Every section keeps its place, its id and its page marker.
		expect(
			sections.map((section) => [section.index, section.title]),
		).toEqual([
			[1, "Overview"],
			[2, "Appendix A · Sources"],
			[3, "Pricing"],
			[4, "12. Appendix B: Data"],
			[5, "Appendix"],
		]);
		expect(body).toContain(
			`<header class="pa-section-opener pa-appendix" id="pa-section-2" data-label="Appendix A"><span class="pa-page-marker" aria-hidden="true">${pageMarkerText(2)}</span><h2>Appendix A · Sources</h2></header>`,
		);
		// The section after an appendix is an ordinary one: the theme's
		// counter, which an appendix does not advance, numbers it 2.
		expect(body).toContain(
			'<header class="pa-section-opener" id="pa-section-3"><span',
		);
		expect(body).toContain(
			'<header class="pa-section-opener pa-appendix" id="pa-section-4" data-label="Appendix B">',
		);
		expect(body).toContain(
			'<header class="pa-section-opener pa-appendix" id="pa-section-5" data-label="Appendix">',
		);

		// The entry keeps the heading as typed, less a typed number.
		const entries = Array.from(
			contentsOf(html).matchAll(/<li[^>]*><a[^>]*>[^<]*<\/a>/g),
			(match) => match[0],
		);
		expect(entries).toEqual([
			'<li><a href="#pa-section-1">Overview</a>',
			'<li class="pa-appendix" data-label="A"><a href="#pa-section-2">Appendix A · Sources</a>',
			'<li><a href="#pa-section-3">Pricing</a>',
			'<li class="pa-appendix" data-label="B"><a href="#pa-section-4">Appendix B: Data</a>',
			'<li class="pa-appendix" data-label=""><a href="#pa-section-5">Appendix</a>',
		]);

		// Both passes write the same contents markup; only the slots differ.
		const final = build(doc, {
			pass: {
				kind: "final",
				pageNumbers: new Map([
					[1, 3],
					[2, 4],
					[3, 5],
					[4, 6],
					[5, 7],
				]),
			},
		}).html;
		const emptySlots = (text: string) =>
			text.replace(
				/<span class="pa-contents-page">[^<]*<\/span>/g,
				'<span class="pa-contents-page"></span>',
			);
		expect(contentsOf(final)).not.toBe(contentsOf(html));
		expect(emptySlots(contentsOf(final))).toBe(contentsOf(html));
	});
});

describe("buildThemeHtml: fences", () => {
	it("draws a valid stat tiles block as tiles, its text escaped", () => {
		const { html } = build(
			[
				// Inside a section, so the cover does not take it.
				"## Results",
				"",
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

	it("draws a valid cards block as a grid of cards, label as written, title and text with their marks", () => {
		const { html } = build(
			[
				// Inside a section, so the cover does not take what precedes it.
				"## Approach",
				"",
				"```cards",
				"%% fabric-visual: a1b2c3d4e5f6",
				"01",
				"**Route planning**",
				"Plans each day's *stops* before `08:00`.",
				"",
				"Pilot **site**",
				"**Example Harbor Co**",
				"",
				"Scope",
				"Three depots, ***twelve*** weeks.",
				"",
				"Fee",
				"**Fixed**",
				"Paid in two parts.",
				"```",
			].join("\n"),
		);

		expect(bodyOf(html)).toContain(
			[
				'<div class="pa-cards">',
				'<div class="pa-card"><p class="pa-card-label">01</p><p class="pa-card-title">Route planning</p><p class="pa-card-text">Plans each day&#39;s <em>stops</em> before <code>08:00</code>.</p></div>',
				// A label is printed as typed, never read as Markdown.
				'<div class="pa-card"><p class="pa-card-label">Pilot **site**</p><p class="pa-card-title">Example Harbor Co</p></div>',
				'<div class="pa-card"><p class="pa-card-label">Scope</p><p class="pa-card-text">Three depots, <strong><em>twelve</em></strong> weeks.</p></div>',
				'<div class="pa-card"><p class="pa-card-label">Fee</p><p class="pa-card-title">Fixed</p><p class="pa-card-text">Paid in two parts.</p></div>',
				"</div>",
			].join(""),
		);
		expect(bodyOf(html)).not.toContain("pa-cards-3");
		expect(bodyOf(html)).not.toContain("fabric-visual");
		expect(bodyOf(html)).not.toContain("language-cards");
	});

	it("sets exactly three cards in one row, and any other count two across", () => {
		const cards = (count: number) =>
			bodyOf(
				build(
					[
						"## Approach",
						"",
						"```cards",
						Array.from(
							{ length: count },
							(_, index) =>
								`Label ${index + 1}\nText ${index + 1}.`,
						).join("\n\n"),
						"```",
					].join("\n"),
				).html,
			);

		expect(cards(3)).toContain('<div class="pa-cards pa-cards-3">');
		for (const count of [1, 2, 4]) {
			expect({
				count,
				grid: cards(count).match(/class="pa-cards[^"]*"/g),
			}).toEqual({
				count,
				grid: ['class="pa-cards"'],
			});
		}
	});

	it("prints a card's label, title and text escaped, never as markup", () => {
		const { html } = build(
			[
				"## Approach",
				"",
				"```cards",
				'<img src=x onerror="alert(1)">',
				"**<b>Title</b>**",
				"Risk: <script>alert(1)</script> & more",
				"```",
			].join("\n"),
		);
		const body = bodyOf(html);

		expect(body).toContain(
			'<p class="pa-card-label">&lt;img src=x onerror=&quot;alert(1)&quot;&gt;</p><p class="pa-card-title">&lt;b&gt;Title&lt;/b&gt;</p><p class="pa-card-text">Risk: &lt;script&gt;alert(1)&lt;/script&gt; &amp; more</p>',
		);
		expect(body).not.toContain("<script>");
		expect(startTags(body).map((tag) => tag.name)).not.toContain("img");
	});

	it("draws a valid columns block as two columns of headings, bullets and paragraphs", () => {
		const { html } = build(
			[
				"## Approach",
				"",
				"```columns",
				"### Today",
				"- Paper route sheets",
				"- Calls to *every* depot",
				"---",
				"#### With the platform",
				"One schedule **every** depot reads.",
				"",
				"Escaped: <script>alert(1)</script>",
				"```",
			].join("\n"),
		);
		const body = bodyOf(html);

		expect(body).toContain(
			[
				'<div class="pa-columns">',
				'<div class="pa-column"><p class="pa-column-heading">Today</p><ul><li>Paper route sheets</li><li>Calls to <em>every</em> depot</li></ul></div>',
				'<div class="pa-column"><p class="pa-column-heading">With the platform</p><p>One schedule <strong>every</strong> depot reads.</p><p>Escaped: &lt;script&gt;alert(1)&lt;/script&gt;</p></div>',
				"</div>",
			].join(""),
		);
		expect(body).not.toContain("<script>");
		// A column heading is a paragraph, never a heading the outline counts.
		expect(startTags(body).map((tag) => tag.name)).not.toContain("h3");
		expect(startTags(body).map((tag) => tag.name)).not.toContain("h4");
	});

	it("prints cards, columns and stat tiles without the citation markers written into them", () => {
		const body = bodyOf(
			build(
				[
					"## Results",
					"",
					"```cards",
					"01",
					"**Route planning**",
					"Saves 12 hours a week [S2]",
					"",
					"Pilot",
					"[S4]",
					"Twelve weeks.",
					"```",
					"",
					"```columns",
					"### Today",
					"- Paper route sheets [cite]",
					"---",
					"One schedule.",
					"```",
					"",
					"```stat-tiles",
					"Hours saved [S1]: 12",
					"Pilot sites: 3 [S3]",
					"```",
				].join("\n"),
			).html,
		);

		expect(body).toContain(
			[
				'<div class="pa-cards">',
				'<div class="pa-card"><p class="pa-card-label">01</p><p class="pa-card-title">Route planning</p><p class="pa-card-text">Saves 12 hours a week</p></div>',
				'<div class="pa-card"><p class="pa-card-label">Pilot</p><p class="pa-card-text">Twelve weeks.</p></div>',
				"</div>",
			].join(""),
		);
		expect(body).toContain(
			'<div class="pa-column"><p class="pa-column-heading">Today</p><ul><li>Paper route sheets</li></ul></div>',
		);
		expect(body).toContain(
			'<dl class="pa-stat-tiles"><div class="pa-stat-tile"><dt class="pa-stat-label">Hours saved</dt><dd class="pa-stat-value">12</dd></div><div class="pa-stat-tile"><dt class="pa-stat-label">Pilot sites</dt><dd class="pa-stat-value">3</dd></div></dl>',
		);
		expect(body).not.toMatch(/\[(?:S\d|cite)/);
	});

	it.each([
		// The first line is the label, so a bold first line is refused.
		["cards", "**A bold first line**\nText."],
		// Two sides need one --- line between them.
		["columns", "### Only one side\n- No separator"],
	])(
		"prints a refused %s block as code, as the page does",
		(language, source) => {
			const { html } = build(
				["## Approach", "", `\`\`\`${language}`, source, "```"].join(
					"\n",
				),
			);

			expect(bodyOf(html)).toContain(
				`<pre><code class="language-${language}">${source}</code></pre>`,
			);
			expect(bodyOf(html)).not.toContain(`class="pa-${language}`);
		},
	);

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
					{
						kind: "placeholder",
						caption: "Not available.",
					},
				],
			}).html,
		);
		expect(body).toContain(
			'<figure class="pa-figure pa-diagram"><svg viewBox="0 0 10 10"><text>drawn</text></svg><figcaption class="pa-caption"><span class="pa-figure-number">Figure 1.</span> Plan &lt;b&gt;for&lt;/b&gt; Acme &amp; partners</figcaption></figure>',
		);
		expect(body).toContain(
			'<p class="pa-caption">Not available.</p><figcaption class="pa-caption"><span class="pa-figure-number">Figure 2.</span> Not drawn</figcaption></figure>',
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
			'<figcaption class="pa-caption"><span class="pa-figure-number">Figure 1.</span> Rollout plan</figcaption>',
		);
		expect(body).toContain(
			'<figcaption class="pa-caption"><span class="pa-figure-number">Figure 2.</span></figcaption>',
		);
		expect(body).not.toContain("[S");
	});

	it("still numbers a diagram without a caption", () => {
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
		expect(body).toContain(
			'<svg viewBox="0 0 10 10"></svg><figcaption class="pa-caption"><span class="pa-figure-number">Figure 1.</span></figcaption>',
		);
	});

	it("gives a diagram right under a section opener, past its subtitle and every block that prints nothing, the shorter height print allows it there, as the page places it", () => {
		const fence = (index: number) =>
			`\`\`\`mermaid\nflowchart LR\n  A${index} --> B\n\`\`\``;
		const markdown = [
			// The letter's heading opens no section.
			"## Cover letter",
			fence(0),
			"Kind regards,",
			"## Overview",
			fence(1),
			fence(2),
			"## Approach",
			"*How the work runs.*",
			fence(3),
			"## Delivery",
			"The plan in brief.",
			fence(4),
			"## Steps",
			`- A step\n\n  ${fence(5).replaceAll("\n", "\n  ")}`,
			"## Review",
			"[example]: https://example.com",
			fence(6),
			// Each of these prints nothing: an author's comment, a Markdown
			// image and an image tag from elsewhere (both dropped), a
			// footnote's text, a cover block the cover did not take, a table
			// with nothing in it, a diagram left out and an upload whose bytes
			// were not read.
			"## Notes",
			"<!-- reviewer note -->",
			fence(7),
			"## Sources",
			"![remote](https://example.com/remote.png)",
			fence(8),
			"## Elsewhere",
			'<img src="https://example.com/remote.png" alt="Remote">',
			fence(9),
			"## Footnotes",
			"[^note]: A note no line calls.",
			fence(10),
			"## Second cover",
			"```cover\nfor: Example Harbor Co\n```",
			fence(11),
			"## Empty table",
			"|  |  |\n| - | - |",
			fence(12),
			"## Left out",
			fence(13),
			fence(14),
			"## Missing upload",
			imageTag(mediaKey("missing.png")),
			fence(15),
			// An upload with its bytes prints a figure of its own first.
			"## Upload",
			imageTag(mediaKey("chart.png")),
			fence(16),
		].join("\n\n");
		const prepared = prepareExportMarkdown(markdown);
		const images = new Map([[mediaKey("chart.png"), png]]);
		const diagrams = prepared.diagramSources.map(
			(_, index): ExportDiagram =>
				index === 13
					? { kind: "omitted" }
					: {
							kind: "svg",
							svg: `<svg viewBox="0 0 10 10"><text>d${index}</text></svg>`,
							width: 10,
							height: 10,
							png: null,
						},
		);
		const heights = printFigureMaxHeights(
			prepared,
			printedBlockFacts(
				{ images, projectId: PROJECT, documentId: DOCUMENT },
				diagrams,
			),
		);
		const opener = PRINT_FIGURE_UNDER_OPENER_MAX_HEIGHT_PX;
		const own = PRINT_FIGURE_MAX_HEIGHT_PX;
		expect(heights).toEqual([
			own,
			opener,
			own,
			opener,
			// After a paragraph, still on the opener's page.
			printFigureUnderOpenerMaxHeightPx("Delivery", null, [
				{ kind: "paragraph", text: "The plan in brief." },
			]),
			own,
			opener,
			...Array.from({ length: 6 }, () => opener),
			own,
			opener,
			opener,
			own,
		]);

		// The print layer's rules read the page: a figure that comes right
		// after an opener's header, or one that carries a lower limit.
		const body = bodyOf(build(markdown, { diagrams, images }).html);
		expect(
			diagrams.map((_, index) => {
				const figure = new RegExp(
					`(</header>)?<figure [^>]*?(?: style="--pa-figure-max-height: (\\d+)px")?><svg viewBox="0 0 10 10"><text>d${index}</text>`,
				).exec(body);
				return figure?.[2]
					? Number(figure[2])
					: figure?.[1]
						? opener
						: own;
			}),
		).toEqual(heights);
	});

	it("keeps a diagram under a long section opener shorter by the lines its text takes, writes that limit on its figure, and measures its labels at the same number", () => {
		const fence = (index: number) =>
			`\`\`\`mermaid\nflowchart TD\n  A${index} --> B\n\`\`\``;
		const long =
			"How the pilot moves every request from the first interview with dispatch to the measured review of cost and adoption";
		const subtitle =
			"Every request the crews raise moves through the same twenty steps, from the intake desk to the archive, so the closing review can compare the pilot region with the baseline on cost and response times.";
		const markdown = [
			"## Plan",
			fence(0),
			`## ${long}`,
			`*${subtitle}*`,
			fence(1),
			// A line break starts a line; a soft one in the subtitle does not.
			"## Plan<br>for<br>the<br>pilot",
			fence(2),
			`## ${long}`,
			"*Short\nline*",
			fence(3),
			"## Plan for the pilot",
			fence(4),
		].join("\n\n");
		const prepared = prepareExportMarkdown(markdown);
		const diagrams = prepared.diagramSources.map(
			(_, index): ExportDiagram => ({
				kind: "svg",
				svg: `<svg viewBox="0 0 10 10"><text>d${index}</text></svg>`,
				width: 10,
				height: 10,
				png: null,
			}),
		);
		const printed = {
			images: new Map(),
			projectId: PROJECT,
			documentId: DOCUMENT,
		};
		const heights = printFigureMaxHeights(
			prepared,
			printedBlockFacts(printed, diagrams),
		);
		const under = PRINT_FIGURE_UNDER_OPENER_MAX_HEIGHT_PX;
		expect(heights[1]).toBeLessThan(under);
		expect(heights[2]).toBeLessThan(under);
		expect(heights[3]).toBeLessThan(under);
		expect(heights[1]).toBeLessThan(heights[3] ?? 0);
		expect(heights).toEqual([
			under,
			printFigureUnderOpenerMaxHeightPx(long, subtitle),
			printFigureUnderOpenerMaxHeightPx("Plan\nfor\nthe\npilot", null),
			printFigureUnderOpenerMaxHeightPx(long, "Short line"),
			under,
		]);

		// The diagram step, which draws the fences in order, measures each
		// at the same height.
		const measure = printFigureMaxHeight(prepared, printed);
		expect(
			heights.map((_, index) => measure(index, diagrams.slice(0, index))),
		).toEqual(heights);

		// The page writes a limit lower than the rule's on the figure, in
		// the property the rule reads first, and nothing on the others.
		const body = bodyOf(build(markdown, { diagrams }).html);
		const written = Array.from(
			body.matchAll(
				/<figure class="pa-figure pa-diagram"(?: style="--pa-figure-max-height: (\d+)px")?><svg viewBox="0 0 10 10"><text>d(\d+)<\/text>/g,
			),
			(match) => [Number(match[2]), match[1] ? Number(match[1]) : null],
		);
		expect(written).toEqual([
			[0, null],
			[1, heights[1]],
			[2, heights[2]],
			[3, heights[3]],
			[4, null],
		]);
	});

	it("keeps the first diagram after short blocks on an opener's page shorter by their lines, writes that limit on its figure, and measures its labels at the same number", () => {
		const fence = (index: number) =>
			`\`\`\`mermaid\nflowchart TD\n  A${index} --> B\n\`\`\``;
		const paragraph =
			"Every request moves through the same steps, from the intake desk to the archive.";
		const markdown = [
			"## How a request moves",
			paragraph,
			fence(0),
			"## How the teams work",
			"- Dispatch\n- Crew leads",
			fence(1),
			// A block that is not short text, and text past the floor, leave
			// the figure after them its own height.
			"## Notes",
			"> A callout.",
			fence(2),
			"## Background",
			Array.from({ length: 14 }, () => paragraph).join(" "),
			fence(3),
			// Only the first figure shares the opener's page.
			"## Review",
			paragraph,
			fence(4),
			fence(5),
		].join("\n\n");
		const prepared = prepareExportMarkdown(markdown);
		const diagrams = prepared.diagramSources.map(
			(_, index): ExportDiagram => ({
				kind: "svg",
				svg: `<svg viewBox="0 0 10 10"><text>d${index}</text></svg>`,
				width: 10,
				height: 10,
				png: null,
			}),
		);
		const printed = {
			images: new Map(),
			projectId: PROJECT,
			documentId: DOCUMENT,
		};
		const heights = printFigureMaxHeights(
			prepared,
			printedBlockFacts(printed, diagrams),
		);
		const own = PRINT_FIGURE_MAX_HEIGHT_PX;
		expect(heights[0]).toBeLessThan(
			PRINT_FIGURE_UNDER_OPENER_MAX_HEIGHT_PX,
		);
		expect(heights[1]).toBeLessThan(
			PRINT_FIGURE_UNDER_OPENER_MAX_HEIGHT_PX,
		);
		expect(heights).toEqual([
			printFigureUnderOpenerMaxHeightPx("How a request moves", null, [
				{ kind: "paragraph", text: paragraph },
			]),
			printFigureUnderOpenerMaxHeightPx("How the teams work", null, [
				{ kind: "list", items: ["Dispatch", "Crew leads"] },
			]),
			own,
			own,
			heights[0],
			own,
		]);

		// The diagram step measures each at the same height.
		const measure = printFigureMaxHeight(prepared, printed);
		expect(
			heights.map((_, index) => measure(index, diagrams.slice(0, index))),
		).toEqual(heights);

		// The page writes each limit lower than a figure's own on its figure.
		const body = bodyOf(build(markdown, { diagrams }).html);
		const written = Array.from(
			body.matchAll(
				/<figure class="pa-figure pa-diagram"(?: style="--pa-figure-max-height: (\d+)px")?><svg viewBox="0 0 10 10"><text>d(\d+)<\/text>/g,
			),
			(match) => [Number(match[2]), match[1] ? Number(match[1]) : null],
		);
		expect(written).toEqual([
			[0, heights[0]],
			[1, heights[1]],
			[2, null],
			[3, null],
			[4, heights[0]],
			[5, null],
		]);
	});

	it("writes a figure's own height on a figure on an opener's page whose labels the room there would take below the floor, and the diagram step measures the same number", () => {
		const fence = (index: number) =>
			`\`\`\`mermaid\nflowchart TD\n  A${index} --> B\n\`\`\``;
		const paragraph = "Every request takes these steps.";
		const markdown = [
			// Right under an opener, at 600 px.
			"## Tall flow",
			fence(0),
			"## Flow that shrinks a little",
			fence(1),
			"## Tall template",
			fence(2),
			"## Short template",
			fence(3),
			// After a paragraph, at less.
			"## After a paragraph",
			paragraph,
			fence(4),
			"## Tall flow after a paragraph",
			paragraph,
			fence(5),
		].join("\n\n");
		const drawing = (
			index: number,
			height: number,
			textPx?: number,
		): ExportDiagram => ({
			kind: "svg",
			svg: `<svg viewBox="0 0 300 ${height}"><text>d${index}</text></svg>`,
			width: index === 2 || index === 3 ? 662 : 300,
			height,
			...(textPx === undefined ? {} : { textPx }),
			png: null,
		});
		// A flow's labels reach the floor at 9 / 9.75 of its height; a
		// template's 12 px text at its full height.
		const diagrams = [
			drawing(0, 735),
			drawing(1, 640),
			drawing(2, 620, 12),
			drawing(3, 500, 12),
			drawing(4, 565),
			drawing(5, 735),
		];
		const prepared = prepareExportMarkdown(markdown);
		const printed = {
			images: new Map(),
			projectId: PROJECT,
			documentId: DOCUMENT,
		};
		const offered = printFigureMaxHeights(
			prepared,
			printedBlockFacts(printed, diagrams),
		);
		const under = PRINT_FIGURE_UNDER_OPENER_MAX_HEIGHT_PX;
		const own = PRINT_FIGURE_MAX_HEIGHT_PX;
		const afterParagraph = printFigureUnderOpenerMaxHeightPx(
			"After a paragraph",
			null,
			[{ kind: "paragraph", text: paragraph }],
		);
		expect(offered).toEqual([
			under,
			under,
			under,
			under,
			afterParagraph,
			printFigureUnderOpenerMaxHeightPx(
				"Tall flow after a paragraph",
				null,
				[{ kind: "paragraph", text: paragraph }],
			),
		]);
		expect(afterParagraph).toBeLessThan(565);

		// Before a fence is drawn the diagram step reads what is offered;
		// once drawn, the height it prints at.
		const measure = printFigureMaxHeight(prepared, printed);
		expect(
			offered.map((_, index) => measure(index, diagrams.slice(0, index))),
		).toEqual(offered);
		const heights = offered.map((_, index) => measure(index, diagrams));
		expect(heights).toEqual([own, under, own, under, afterParagraph, own]);

		// The page writes each height the rule would not give on its own.
		const body = bodyOf(build(markdown, { diagrams }).html);
		const written = Array.from(
			body.matchAll(
				/<figure class="pa-figure pa-diagram"(?: style="--pa-figure-max-height: (\d+)px")?><svg viewBox="0 0 300 \d+"><text>d(\d+)<\/text>/g,
			),
			(match) => [Number(match[2]), match[1] ? Number(match[1]) : null],
		);
		expect(written).toEqual([
			[0, own],
			[1, null],
			[2, own],
			[3, null],
			[4, afterParagraph],
			[5, own],
		]);
	});

	it("opens a section on its wide table's landscape page past a block that prints nothing, and still counts what that block leaves out", () => {
		const { html, warnings } = build(
			[
				"## Pricing",
				"",
				"Fees by phase.",
				"",
				"## Appendix A: Assumptions",
				"",
				"![remote](https://example.com/remote.png)",
				"",
				"| 1 | 2 | 3 | 4 | 5 | 6 | 7 |",
				"| - | - | - | - | - | - | - |",
				"| a | b | c | d | e | f | g |",
			].join("\n"),
		);
		const body = bodyOf(html);
		expect(body.match(/<section class="pa-landscape">/g)).toHaveLength(1);
		expect(body).toMatch(
			/<section class="pa-landscape"><header class="pa-section-opener pa-appendix" id="pa-section-2" data-label="Appendix A"><h2>Appendix A: Assumptions<\/h2><\/header><table class="pa-data-table[^"]*">.*?<\/table><\/section>/,
		);
		expect(warnings).toEqual([
			{ code: "EXTERNAL_IMAGE_DROPPED", count: 1 },
		]);
	});

	it("takes each diagram by its fence, nested ones included, and numbers only those that print", () => {
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
				{ kind: "omitted" },
				{
					kind: "placeholder",
					caption: "Diagram <unavailable>",
				},
			],
		});
		const body = bodyOf(html);

		const figures = Array.from(
			body.matchAll(
				/<figure class="pa-figure ([a-z-]+)">(.*?)<\/figure>/g,
			),
			(match) => [match[1], match[2]],
		);
		// The left-out diagram takes no number, so the placeholder after it
		// is the second figure; the last fence, which the diagram step
		// returned nothing for, prints nothing either.
		expect(figures).toEqual([
			[
				"pa-diagram",
				'<svg viewBox="0 0 10 10"><text>first</text></svg><figcaption class="pa-caption"><span class="pa-figure-number">Figure 1.</span></figcaption>',
			],
			[
				"pa-diagram-placeholder",
				'<p class="pa-caption">Diagram &lt;unavailable&gt;</p><figcaption class="pa-caption"><span class="pa-figure-number">Figure 2.</span></figcaption>',
			],
		]);
		expect(body).toMatch(
			/<blockquote[^>]*><figure class="pa-figure pa-diagram-placeholder">/,
		);
		expect(body).toMatch(/<li><p>A step<\/p><\/li>/);
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
			/<section class="pa-landscape"><header class="pa-section-opener pa-appendix" id="pa-section-2" data-label="Appendix A"><h2>Appendix A: Assumptions<\/h2><\/header><table class="pa-data-table[^"]*">.*?<\/table><\/section><p>Start date: TBD<\/p>/,
		);
		// The first section's opener stays in the portrait flow.
		expect(body).toMatch(
			/<header class="pa-section-opener" id="pa-section-1"><h2>Pricing<\/h2><\/header><p>Fees by phase\.<\/p>/,
		);
	});

	it("marks a first column of short ids, and only when every body cell is one", () => {
		const table = (cells: string[]) =>
			[
				"| ID | Capability |",
				"| --- | --- |",
				...cells.map((cell) => `| ${cell} | Example |`),
			].join("\n");
		const marked = (markdown: string) =>
			bodyOf(build(markdown).html).includes(
				'<table class="pa-data-table pa-id-column">',
			);

		expect(marked(table(["FS-01", "FS-02", "REQ-1234-AB"]))).toBe(true);
		expect(marked(table(["FS-01", "FS 02"]))).toBe(false);
		expect(marked(table(["FS-01", "ABCDEFGHIJKLM"]))).toBe(false);
		expect(marked(table(["FS-01", "**FS-02**x"]))).toBe(true);
		expect(marked(table(["FS-01", "FS_02"]))).toBe(false);
		expect(marked(table(["FS-01", " "]))).toBe(false);
		// Plain words and single letters are not ids: an id has a digit.
		expect(marked(table(["Discovery", "Build", "Launch"]))).toBe(false);
		expect(marked(table(["A", "B"]))).toBe(false);
		expect(marked(table(["FS-01", "Pro"]))).toBe(false);
		expect(marked(table(["1", "2a"]))).toBe(true);
		// A table with a header row alone has no ids to set.
		expect(marked("| ID | Capability |\n| --- | --- |")).toBe(false);
	});

	it("prints a table whose header cells are all empty without a header row, its first row plain", () => {
		const table = (header: string, ...rows: string[]) =>
			[header, "| --- | --- |", ...rows].join("\n");
		const bodyRows =
			"<tbody><tr><td>Scope</td><td>Pilot</td></tr><tr><td>Fee</td><td>$9</td></tr></tbody>";

		for (const header of ["|  |  |", "| <!-- note --> | <br> |"]) {
			const body = bodyOf(
				build(table(header, "| Scope | Pilot |", "| Fee | $9 |")).html,
			);
			expect({ header, body }).toEqual({
				header,
				body: expect.stringContaining(
					`<table class="pa-data-table pa-headerless">${bodyRows}</table>`,
				),
			});
			expect(body).not.toContain("<thead>");
		}
		// An id column still reads from the body rows.
		expect(
			bodyOf(build(table("|  |  |", "| FS-01 | Pilot |")).html),
		).toContain('<table class="pa-data-table pa-id-column pa-headerless">');
		// A blank header over nothing prints nothing, and a wide one takes
		// no landscape page with its section.
		expect(bodyOf(build(table("|  |  |")).html)).not.toContain("<table");
		const wide = bodyOf(
			build(
				`## Rates\n\n|${"  |".repeat(7)}\n|${" --- |".repeat(7)}\n\nAfter.`,
			).html,
		);
		expect(wide).not.toContain("<table");
		expect(wide).not.toContain("pa-landscape");
		expect(wide).toContain(
			'<header class="pa-section-opener" id="pa-section-1"><h2>Rates</h2></header><p>After.</p>',
		);
	});

	it("keeps the header row when any header cell holds text or an image", () => {
		const withText = bodyOf(
			build("|  | Pilot |\n| --- | --- |\n| Fee | $9 |").html,
		);
		expect(withText).toContain(
			'<table class="pa-data-table"><thead><tr><th></th><th>Pilot</th></tr></thead>',
		);

		const withImage = bodyOf(
			build(
				`| ${imageTag(mediaKey("logo.png"))} |  |\n| --- | --- |\n| Fee | $9 |`,
				{ images: new Map([[mediaKey("logo.png"), png]]) },
			).html,
		);
		expect(withImage).toMatch(
			/<table class="pa-data-table"><thead><tr><th><img src="data:image\/png;base64,/,
		);
		expect(withImage).not.toContain("pa-headerless");
	});

	it("keeps the header row over a Markdown image, which prints nothing, and over a footnote call", () => {
		const image = build(
			"| ![Logo](https://example.com/logo.png) |  |\n| --- | --- |\n| Fee | $9 |",
		);
		expect(bodyOf(image.html)).toContain(
			'<table class="pa-data-table"><thead><tr><th></th><th></th></tr></thead>',
		);
		expect(image.warnings).toEqual([
			{ code: "EXTERNAL_IMAGE_DROPPED", count: 1 },
		]);

		const note = bodyOf(
			build(
				"| [^1] |  |\n| --- | --- |\n| Fee | $9 |\n\n[^1]: Example note.",
			).html,
		);
		expect(note).toContain(
			'<table class="pa-data-table"><thead><tr><th><sup><a href="#pa-fn-1">1</a></sup></th><th></th></tr></thead>',
		);
		expect(note).not.toContain("pa-headerless");
	});

	it("numbers an ordered list as steps only when every item opens with bold text", () => {
		const steps = [
			"Intro.",
			"",
			"1. **Approve the pilot.** Signature starts week one.",
			"2. **Name the sponsor.** One per region.",
		].join("\n");
		expect(bodyOf(build(steps).html)).toContain(
			'<ol class="pa-steps"><li><strong>Approve the pilot.</strong> Signature starts week one.</li>',
		);
		// The start number survives: the steps count from it.
		expect(
			bodyOf(
				build(steps.replace("1. **", "4. **").replace("2. **", "5. **"))
					.html,
			),
		).toContain('<ol start="4" class="pa-steps">');

		for (const markdown of [
			"Intro.\n\n1. **Bold** first\n2. Plain second",
			"Intro.\n\n1. Plain **then bold**\n2. **Bold** second",
			"Intro.\n\n- **Bold** bullet\n- **Bold** bullet",
		]) {
			expect(bodyOf(build(markdown).html)).not.toContain("pa-steps");
		}
	});

	it("prints lists, task items, callouts, code, rules and inline forms", () => {
		const { html } = build(
			[
				// The cover takes the first paragraph as its lead.
				"Intro.",
				"",
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
				// The cover takes the first paragraph as its lead.
				"Intro.",
				"",
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

/** The cover section of a printed page. */
function coverSectionOf(html: string): string {
	const body = bodyOf(html);
	const start = body.indexOf('<section class="pa-cover">');
	expect(start).toBeGreaterThan(-1);
	return body.slice(start, body.indexOf("</section>", start) + 10);
}

/** What follows the cover: the letter, the contents page and the body. */
function afterCoverOf(html: string): string {
	const body = bodyOf(html);
	return body.slice(body.indexOf("</section>") + 10);
}

const COVER_FENCE = [
	"```cover",
	"eyebrow: Proposal · Operations board",
	"organization: Example Harbor Co · Harbour operations",
	"for: Example Harbor Co",
	"for: 1 Example Quay, Example City",
	"by: Example Studio",
	"by: example.com",
	"version: 12",
	"```",
].join("\n");

describe("buildThemeHtml: cover details", () => {
	it("sets the eyebrow, the organization line, the party lines and the version from a cover fence, and prints the fence nowhere else", () => {
		const { html } = build(`${COVER_FENCE}\n\n## Overview\n\nText.`);

		expect(coverSectionOf(html)).toBe(
			[
				'<section class="pa-cover">',
				'<p class="pa-cover-organization">Example Harbor Co · Harbour operations</p>',
				'<div class="pa-cover-body">',
				'<p class="pa-eyebrow">Proposal · Operations board</p>',
				'<h1 class="pa-cover-title">Example Proposal</h1>',
				"</div>",
				'<div class="pa-cover-parties">',
				'<dl class="pa-cover-party-for"><dt>Prepared for</dt><dd>Example Harbor Co</dd><dd>1 Example Quay, Example City</dd></dl>',
				'<div class="pa-cover-party-by"><dl><dt>Prepared by</dt><dd>Example Studio</dd><dd>example.com</dd></dl><p class="pa-cover-date">October 15, 2026 · Version 12 · Confidential</p></div>',
				"</div>",
				"</section>",
			].join(""),
		);
		// The token names are only the fallback.
		expect(coverSectionOf(html)).not.toContain("Example Client");
		expect(coverSectionOf(html)).not.toContain("Example Org");
		const rest = afterCoverOf(html);
		expect(rest).not.toContain("language-cover");
		expect(rest).not.toContain("eyebrow:");
		expect(rest).not.toContain("Harbour operations");
	});

	it("sets the organization line after the brands row, so the body keeps its place under it", () => {
		const { html } = build(`${COVER_FENCE}\n\n## Overview`, {
			tokens: exportTokens({ recipientLogo: png }),
		});

		expect(coverSectionOf(html)).toMatch(
			/<div class="pa-cover-brands"><img class="pa-cover-logo pa-cover-logo-recipient" [^>]*><\/div><p class="pa-cover-organization">Example Harbor Co · Harbour operations<\/p><div class="pa-cover-body">/,
		);
	});

	it("keeps the default of each field the fence leaves out", () => {
		const cover = (lines: string[]) =>
			coverSectionOf(
				build(
					["```cover", ...lines, "```", "", "## Overview"].join("\n"),
				).html,
			);

		const onlyVersion = cover(["version: 3"]);
		expect(onlyVersion).toContain('<p class="pa-eyebrow">Proposal</p>');
		expect(onlyVersion).not.toContain("pa-cover-organization");
		expect(onlyVersion).toContain(
			'<dl class="pa-cover-party-for"><dt>Prepared for</dt><dd>Example Client</dd></dl>',
		);
		expect(onlyVersion).toContain(
			"<dl><dt>Prepared by</dt><dd>Example Org</dd></dl>",
		);
		expect(onlyVersion).toContain(
			'<p class="pa-cover-date">October 15, 2026 · Version 3 · Confidential</p>',
		);

		const onlyEyebrow = cover(["eyebrow: Proposal · Board"]);
		expect(onlyEyebrow).toContain(
			'<p class="pa-eyebrow">Proposal · Board</p>',
		);
		expect(onlyEyebrow).toContain(
			'<p class="pa-cover-date">October 15, 2026 · Confidential</p>',
		);

		const onlyFor = cover(["for: Example Harbor Co"]);
		expect(onlyFor).toContain(
			'<dl class="pa-cover-party-for"><dt>Prepared for</dt><dd>Example Harbor Co</dd></dl>',
		);
		expect(onlyFor).toContain(
			"<dl><dt>Prepared by</dt><dd>Example Org</dd></dl>",
		);

		const onlyBy = cover(["by: Example Studio"]);
		expect(onlyBy).toContain(
			'<dl class="pa-cover-party-for"><dt>Prepared for</dt><dd>Example Client</dd></dl>',
		);
		expect(onlyBy).toContain(
			"<dl><dt>Prepared by</dt><dd>Example Studio</dd></dl>",
		);

		const onlyOrganization = cover(["organization: Example Harbor Co"]);
		expect(onlyOrganization).toContain(
			'<p class="pa-cover-organization">Example Harbor Co</p>',
		);
		expect(onlyOrganization).toContain(
			'<p class="pa-eyebrow">Proposal</p>',
		);
	});

	it("prints the party lines even when the tokens hold no name", () => {
		const cover = coverSectionOf(
			build(
				"```cover\nfor: Example Harbor Co\nby: Example Studio\n```\n\n## Overview",
				{
					tokens: exportTokens({
						recipientName: null,
						proposerName: null,
					}),
				},
			).html,
		);

		expect(cover).toContain(
			'<div class="pa-cover-parties"><dl class="pa-cover-party-for"><dt>Prepared for</dt><dd>Example Harbor Co</dd></dl><div class="pa-cover-party-by"><dl><dt>Prepared by</dt><dd>Example Studio</dd></dl>',
		);
	});

	it("prints a bare version as Version n, and one that names itself as written", () => {
		const dateLine = (version: string, dateLabel = DATE) =>
			/<p class="pa-cover-date">([^<]*)<\/p>/.exec(
				build(
					`\`\`\`cover\nversion: ${version}\n\`\`\`\n\n## Overview`,
					{
						dateLabel,
					},
				).html,
			)?.[1];

		expect(dateLine("12")).toBe(
			"October 15, 2026 · Version 12 · Confidential",
		);
		expect(dateLine("1.0")).toBe(
			"October 15, 2026 · Version 1.0 · Confidential",
		);
		expect(dateLine("v3")).toBe("October 15, 2026 · v3 · Confidential");
		expect(dateLine("V3.1")).toBe("October 15, 2026 · V3.1 · Confidential");
		expect(dateLine("Version 2.1")).toBe(
			"October 15, 2026 · Version 2.1 · Confidential",
		);
		expect(dateLine("VERSION 4")).toBe(
			"October 15, 2026 · VERSION 4 · Confidential",
		);
		// Without a date, the version opens the line.
		expect(dateLine("12", " ")).toBe("Version 12 · Confidential");
	});

	it("escapes every value of the fence", () => {
		const { html } = build(
			[
				"```cover",
				'eyebrow: <b>Plan</b> & "more"',
				"organization: <script>x</script>",
				"for: <i>Example</i> Harbor",
				"by: Example & 'Studio'",
				"version: <1>",
				"```",
				"",
				"## Overview",
			].join("\n"),
		);
		const cover = coverSectionOf(html);

		expect(cover).toContain(
			'<p class="pa-eyebrow">&lt;b&gt;Plan&lt;/b&gt; &amp; &quot;more&quot;</p>',
		);
		expect(cover).toContain(
			'<p class="pa-cover-organization">&lt;script&gt;x&lt;/script&gt;</p>',
		);
		expect(cover).toContain("<dd>&lt;i&gt;Example&lt;/i&gt; Harbor</dd>");
		expect(cover).toContain("<dd>Example &amp; &#39;Studio&#39;</dd>");
		expect(cover).toContain("Version &lt;1&gt; · Confidential");
		expect(cover).not.toMatch(/<(b|i|script)>/);
	});

	it("prints a refused cover fence as code, and the cover keeps its defaults", () => {
		const { html } = build(
			"```cover\neyebrow: Board\ncolour: red\n```\n\n## Overview",
		);

		expect(coverSectionOf(html)).toContain(
			'<p class="pa-eyebrow">Proposal</p>',
		);
		expect(afterCoverOf(html)).toContain(
			'<pre><code class="language-cover">eyebrow: Board\ncolour: red</code></pre>',
		);
	});

	it("reads only the first cover fence of the preamble, and prints no other the parser takes: not a later one, one after a heading, or one in a Main without sections", () => {
		const twice = build(
			[
				"```cover",
				"eyebrow: First",
				"```",
				"",
				"```cover",
				"eyebrow: Second",
				"```",
				"",
				"## Overview",
				"",
				"```cover",
				"eyebrow: Third",
				"```",
				"",
				"- In a list:",
				"",
				"  ```cover",
				"  eyebrow: Fourth",
				"  ```",
			].join("\n"),
		).html;
		expect(coverSectionOf(twice)).toContain(
			'<p class="pa-eyebrow">First</p>',
		);
		expect(afterCoverOf(twice)).not.toContain("eyebrow:");
		expect(afterCoverOf(twice)).not.toContain("language-cover");
		expect(afterCoverOf(twice)).toContain("In a list:");

		const refusedFirst = build(
			[
				"```cover",
				"colour: red",
				"```",
				"",
				"```cover",
				"eyebrow: Second",
				"```",
				"",
				"## Overview",
			].join("\n"),
		).html;
		expect(coverSectionOf(refusedFirst)).toContain(
			'<p class="pa-eyebrow">Proposal</p>',
		);
		// The refused one prints as code; the one the parser takes does not.
		expect(afterCoverOf(refusedFirst)).toContain(
			'<pre><code class="language-cover">colour: red</code></pre>',
		);
		expect(afterCoverOf(refusedFirst)).not.toContain("eyebrow: Second");

		const underSubheading = build(
			"### Background\n\n```cover\neyebrow: Board\n```\n\n## Overview",
		).html;
		expect(coverSectionOf(underSubheading)).toContain(
			'<p class="pa-eyebrow">Proposal</p>',
		);
		expect(afterCoverOf(underSubheading)).not.toContain("eyebrow: Board");

		const noSections = build("```cover\neyebrow: Board\n```\n\nText.").html;
		expect(coverSectionOf(noSections)).toContain(
			'<p class="pa-eyebrow">Proposal</p>',
		);
		expect(afterCoverOf(noSections)).not.toContain("eyebrow: Board");
		expect(afterCoverOf(noSections)).toContain("<p>Text.</p>");
	});

	it("prints a cover fence the parser refuses as code wherever it stands, and one in another case as code of its own language", () => {
		const { html } = build(
			[
				"## Overview",
				"",
				"```cover",
				"eyebrow: Board",
				"eyebrow: Again",
				"```",
				"",
				"```Cover",
				"eyebrow: Board",
				"```",
			].join("\n"),
		);

		expect(afterCoverOf(html)).toContain(
			'<pre><code class="language-cover">eyebrow: Board\neyebrow: Again</code></pre>',
		);
		expect(afterCoverOf(html)).toContain(
			'<pre><code class="language-Cover">eyebrow: Board</code></pre>',
		);
	});

	it("reads the fence past an opening H1 and beside the lead and key figures, and never prints its marker", () => {
		const { html } = build(
			[
				"# Generated Title",
				"",
				"The short lead.",
				"",
				"```cover",
				"%% fabric-visual: a1b2c3d4e5f6",
				"eyebrow: Proposal · Board",
				"```",
				"",
				"```stat-tiles",
				"Weeks: 12",
				"```",
				"",
				"## Overview",
			].join("\n"),
		);
		const cover = coverSectionOf(html);

		expect(cover).toContain('<p class="pa-eyebrow">Proposal · Board</p>');
		expect(cover).toContain(
			'<h1 class="pa-cover-title">Generated Title</h1>',
		);
		// The lifted fence strands nothing, so the paragraph before it is
		// still the lead.
		expect(cover).toContain('<p class="pa-cover-lead">The short lead.</p>');
		expect(cover).toContain('<dl class="pa-cover-figures">');
		expect(html).not.toContain("fabric-visual");
		expect(afterCoverOf(html)).not.toContain("The short lead.");
	});
});

const LETTER_MAIN = [
	"# Route planning for Example Harbor Co",
	"",
	"A short lead.",
	"",
	"## Cover letter",
	"",
	"12 March 2027",
	"",
	"Jordan Example, Head of Operations, Example Harbor Co",
	"",
	"Re: Route planning for Example Harbor Co",
	"",
	"Thank you for the conversation.",
	"",
	"Kind regards,",
	"",
	"**Alex Example**",
	"",
	"Head of Delivery · Example Studio",
	"",
	"## 1. Overview",
	"",
	"Text.",
	"",
	"## 2. Pricing",
	"",
	"More text.",
].join("\n");

describe("buildThemeHtml: cover letter", () => {
	const letterOf = (html: string) => {
		const start = html.indexOf('<section class="pa-letter"');
		return start === -1
			? ""
			: html.slice(start, html.indexOf("</section>", start) + 10);
	};
	const contentsOf = (html: string) => {
		const start = html.indexOf('<nav class="pa-contents"');
		return start === -1
			? ""
			: html.slice(start, html.indexOf("</nav>", start));
	};
	/** Whether a heading as Main's first H2 opens a letter. */
	const opensLetter = (heading: string) =>
		letterOf(
			build(`## ${heading}\n\nText.\n\n## Overview\n\nMore.`).html,
		) !== "";

	it("prints the first section named Cover letter on its own page between the cover and the contents, with each paragraph in its role", () => {
		const { html, sections } = build(LETTER_MAIN);

		expect(letterOf(html)).toBe(
			[
				'<section class="pa-letter" aria-label="Cover letter">',
				'<div class="pa-letter-head"><p class="pa-letter-label">Cover letter</p></div>',
				'<p class="pa-letter-date">12 March 2027</p>',
				"<p>Jordan Example, Head of Operations, Example Harbor Co</p>",
				'<p class="pa-letter-subject">Re: Route planning for Example Harbor Co</p>',
				"<p>Thank you for the conversation.</p>",
				"<p>Kind regards,</p>",
				'<p class="pa-letter-signer"><strong>Alex Example</strong></p>',
				'<p class="pa-letter-signer-role">Head of Delivery · Example Studio</p>',
				"</section>",
			].join(""),
		);
		// The page order: cover, letter, contents, body.
		expect(html).toMatch(
			/<\/section>\n<section class="pa-letter"[^>]*>[\s\S]*?<\/section>\n<nav class="pa-contents"/,
		);
		// No section of its own: no opener, number or contents entry.
		expect(sections).toEqual([
			{ index: 1, id: "pa-section-1", title: "1. Overview" },
			{ index: 2, id: "pa-section-2", title: "2. Pricing" },
		]);
		expect(contentsOf(html)).not.toContain("Cover letter");
		expect(contentsOf(html).match(/<li[ >]/g)).toHaveLength(2);
		expect(html.match(/class="pa-section-opener/g)).toHaveLength(2);
		expect(html).not.toMatch(/<h2>Cover letter<\/h2>/);
		// Printed once, on its own page.
		expect(html.match(/Kind regards,/g)).toHaveLength(1);
	});

	it("recognises the heading in any case, with a typed number, in German, and only as the first H2", () => {
		for (const heading of [
			"Cover letter",
			"COVER LETTER",
			"cover letter",
			"1. Cover letter",
			"2) Cover Letter",
			"Cover letter:",
			"Anschreiben",
			"1. Anschreiben.",
		]) {
			expect({ heading, letter: opensLetter(heading) }).toEqual({
				heading,
				letter: true,
			});
		}
		for (const heading of [
			"Cover letters",
			"Cover letter and terms",
			"Our cover letter",
			"Letter",
			"Appendix A · Cover letter",
		]) {
			expect({ heading, letter: opensLetter(heading) }).toEqual({
				heading,
				letter: false,
			});
		}

		const second = build(
			"## Overview\n\nText.\n\n## Cover letter\n\nDear reader.",
		);
		expect(letterOf(second.html)).toBe("");
		expect(second.sections.map((section) => section.title)).toEqual([
			"Overview",
			"Cover letter",
		]);

		// An H3 of that name is no section at all.
		expect(
			letterOf(build("### Cover letter\n\nText.\n\n## Overview").html),
		).toBe("");
	});

	it("labels the letter with its heading less the typed number", () => {
		expect(
			letterOf(build("## 1. Anschreiben:\n\nText.\n\n## Overview").html),
		).toContain(
			'<section class="pa-letter" aria-label="Anschreiben"><div class="pa-letter-head"><p class="pa-letter-label">Anschreiben</p></div>',
		);
	});

	it("takes the date only from a first paragraph of one line, at most 40 characters and with a digit", () => {
		const first = (paragraph: string) =>
			letterOf(
				build(`## Cover letter\n\n${paragraph}\n\nText.\n\n## Overview`)
					.html,
			);

		const forty = `1 ${"x".repeat(38)}`;
		expect(first(forty)).toContain(
			`<p class="pa-letter-date">${forty}</p>`,
		);
		expect(first(`${forty}x`)).not.toContain("pa-letter-date");
		expect(first("23 October 2026")).toContain(
			'<p class="pa-letter-date">23 October 2026</p>',
		);
		// A salutation has no digit: it prints as the letter's prose.
		expect(first("Dear Jordan Example,")).toContain(
			"<p>Dear Jordan Example,</p>",
		);
		expect(first("Dear Jordan Example,")).not.toContain("pa-letter-date");
		expect(first("12 March\n2027")).not.toContain("pa-letter-date");
		expect(first("12 March  \n2027")).not.toContain("pa-letter-date");
		// A subject line is never the date.
		expect(first("Re: Example")).toContain(
			'<p class="pa-letter-subject">Re: Example</p>',
		);
		expect(first("Re: Example")).not.toContain("pa-letter-date");
		// Only the first block: a date after a list is prose.
		const afterList = letterOf(
			build("## Cover letter\n\n- One\n\n12 March 2027\n\n## Overview")
				.html,
		);
		expect(afterList).not.toContain("pa-letter-date");
	});

	it("takes the last paragraph that is bold and nothing else as the signer, never the subject line, and mutes the paragraph after it", () => {
		const { html } = build(
			[
				"## Cover letter",
				"",
				"12 March 2027",
				"",
				"**Example Harbor Co**",
				"",
				"Dear reader, **thank you** for your time.",
				"",
				"**Alex Example**",
				"",
				"**Re: The proposal**",
				"",
				"Head of Delivery",
				"",
				"## Overview",
			].join("\n"),
		);
		const letter = letterOf(html);

		expect(letter).toContain(
			'<p class="pa-letter-signer"><strong>Alex Example</strong></p>',
		);
		expect(letter).toContain(
			'<p class="pa-letter-subject"><strong>Re: The proposal</strong></p>',
		);
		// The subject line follows the signer, so nothing is muted.
		expect(letter).not.toContain("pa-letter-signer-role");
		expect(letter).toContain("<p>Head of Delivery</p>");
		// An earlier bold paragraph, and a partly bold one, stay prose.
		expect(letter).toContain("<p><strong>Example Harbor Co</strong></p>");
		expect(letter).toContain(
			"<p>Dear reader, <strong>thank you</strong> for your time.</p>",
		);

		const lastSigner = letterOf(
			build("## Cover letter\n\nText.\n\n**Alex Example**\n\n## Overview")
				.html,
		);
		expect(lastSigner).toContain(
			'<p class="pa-letter-signer"><strong>Alex Example</strong></p></section>',
		);
	});

	it("sets the proposer logo at the top left, on a plate of the ink only when it was drawn for a dark background", () => {
		const head = (logo: ExportRaster) =>
			/<div class="pa-letter-head">.*?<\/div>/.exec(
				letterOf(
					build(LETTER_MAIN, {
						tokens: exportTokens({ proposerLogo: logo }),
					}).html,
				),
			)?.[0];
		const data = `data:${png.mimeType};base64,${png.bytes.toString("base64")}`;

		expect(head({ ...png, luminance: 0.04, opaque: false })).toBe(
			`<div class="pa-letter-head"><img class="pa-letter-logo" src="${data}" alt="Example Org logo"><p class="pa-letter-label">Cover letter</p></div>`,
		);
		expect(head({ ...png, luminance: 0.93, opaque: false })).toContain(
			'<img class="pa-letter-logo pa-letter-logo-plate"',
		);
		expect(head({ ...png, luminance: 0.93, opaque: true })).not.toContain(
			"pa-letter-logo-plate",
		);
		expect(head(png)).not.toContain("pa-letter-logo-plate");
		// The recipient's logo never heads the letter.
		expect(
			letterOf(
				build(LETTER_MAIN, {
					tokens: exportTokens({ recipientLogo: png }),
				}).html,
			),
		).not.toContain("<img");
	});

	it("escapes the letter's text and numbers its footnotes before the body's", () => {
		const { html } = build(
			[
				"## Cover letter",
				"",
				'Re: <Plan> & "more"[^a]',
				"",
				"**<b>Alex</b>**",
				"",
				"## Overview",
				"",
				"Claim[^b].",
				"",
				"[^a]: Note a.",
				"[^b]: Note b.",
			].join("\n"),
		);
		const letter = letterOf(html);

		expect(letter).toContain(
			'<p class="pa-letter-subject">Re: &lt;Plan&gt; &amp; &quot;more&quot;<sup><a href="#pa-fn-1">1</a></sup></p>',
		);
		expect(letter).toContain(
			'<p class="pa-letter-signer"><strong>&lt;b&gt;Alex&lt;/b&gt;</strong></p>',
		);
		expect(letter).not.toMatch(/<b>/);
		expect(bodyOf(html)).toContain(
			'<p>Claim<sup><a href="#pa-fn-2">2</a></sup>.</p>',
		);
	});

	it("puts no page marker in the letter, so the locate pass marks only the sections, numbered from one", () => {
		const { html, sections } = build(LETTER_MAIN, { pass: LOCATE });

		expect(
			Array.from(html.matchAll(PAGE_MARKER_PATTERN), (match) =>
				Number(match[1]),
			),
		).toEqual([1, 2]);
		expect(letterOf(html)).not.toContain("pa-page-marker");
		expect(sections.map((section) => section.index)).toEqual([1, 2]);
	});

	it("lays both passes out alike with a cover fence and a letter: only the markers and the slot text differ", () => {
		const main = LETTER_MAIN.replace(
			"A short lead.",
			`A short lead.\n\n${COVER_FENCE}`,
		);
		const locate = build(main, { pass: LOCATE }).html;
		const final = build(main, {
			pass: {
				kind: "final",
				pageNumbers: new Map([
					[1, 4],
					[2, 6],
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

		expect(final).toContain('<p class="pa-cover-organization">');
		expect(final).toContain('<section class="pa-letter"');
		expect(normalized(final)).toBe(normalized(locate));
	});

	it("prints a letter that is Main's only section without a contents page", () => {
		const { html, sections } = build(
			"## Cover letter\n\n12 March 2027\n\nDear reader.",
		);

		expect(sections).toEqual([]);
		expect(html).not.toContain('<nav class="pa-contents"');
		expect(letterOf(html)).toContain(
			'<p class="pa-letter-date">12 March 2027</p><p>Dear reader.</p>',
		);
	});

	it("leaves the page exactly as before when Main has no letter", () => {
		const { html } = build("Intro.\n\n## Overview\n\nText.");

		expect(bodyOf(html)).not.toContain("pa-letter");
		expect(html).toMatch(/<\/section>\n<nav class="pa-contents"/);
	});
});
