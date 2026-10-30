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
			numbered: true,
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
			/<section class="pa-landscape"><header class="pa-section-opener" id="pa-section-1"><h2>Appendix<\/h2><p>Every requirement and where it is met\.<\/p><\/header><table /,
		);
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

	it("prints a diagram's caption line under its figure, escaped, and never in the drawing's source", () => {
		const svg: ExportDiagram = {
			kind: "svg",
			svg: '<svg viewBox="0 0 10 10"><text>drawn</text></svg>',
			width: 10,
			height: 10,
			png: null,
			numbered: true,
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
						numbered: true,
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
			numbered: true,
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
			numbered: true,
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

	it("takes each diagram by its fence, nested ones included, and numbers only those that print", () => {
		const svg = (label: string): ExportDiagram => ({
			kind: "svg",
			svg: `<svg viewBox="0 0 10 10"><text>${label}</text></svg>`,
			width: 10,
			height: 10,
			png: null,
			numbered: true,
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
				{ kind: "omitted", numbered: false },
				{
					kind: "placeholder",
					caption: "Diagram <unavailable>",
					numbered: true,
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
			/<section class="pa-landscape"><header class="pa-section-opener" id="pa-section-2"><h2>Appendix A: Assumptions<\/h2><\/header><table class="pa-data-table[^"]*">.*?<\/table><\/section><p>Start date: TBD<\/p>/,
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

	it("numbers an ordered list in squares only when every item opens with bold text", () => {
		const steps = [
			"Intro.",
			"",
			"1. **Approve the pilot.** Signature starts week one.",
			"2. **Name the sponsor.** One per region.",
		].join("\n");
		expect(bodyOf(build(steps).html)).toContain(
			'<ol class="pa-steps"><li><strong>Approve the pilot.</strong> Signature starts week one.</li>',
		);
		// The start number survives: the squares count from it.
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
