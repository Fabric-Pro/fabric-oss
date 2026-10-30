/**
 * The Proposal PDF printed by a real Chromium (Fizzy #2946): what the export's
 * unit suites cannot see, since they mock the browser and compare strings.
 *
 * A synthetic Proposal with a cover (both logos and a hero) and body text
 * goes through the export's own browser and printer, and the PDF is read
 * back:
 *   - page 1 is the cover alone: no running header or footer printed on it,
 *     and its date still on the page;
 *   - body text keeps the font's own spacing: glyph advances are not rounded
 *     to whole pixels, which is how Linux font hinting printed gaps inside
 *     words.
 *
 * Two fuller synthetic Proposals (`fixtures/proposal-print-fixtures.ts`), one
 * with every element the print design draws and one shaped like a generated
 * Main, go through the export's whole path: Markdown prepared, diagrams
 * drawn (figure templates and Mermaid), the page printed in two passes.
 * Before printing, the same page is laid out in a throwaway browser page of
 * its own and measured: the cover's size and whether its body ends above the
 * parties, and each figure template's width, text size and whether its text
 * stays inside its boxes. The PDFs are then read for their embedded faces,
 * the contents page, the figure numbers and the glyph spacing.
 *
 * A synthetic frame goes through the frame export's own launch and print,
 * and its PDF gets the same glyph-spacing check: both launch with the
 * shared print flags.
 *
 * With `PROPOSAL_PRINT_ARTIFACT_DIR` set, the fixtures' and the frame's PDFs
 * are written there (CI uploads them for a human page-by-page review). With
 * `PROPOSAL_PRINT_CHROMIUM_PATH` set, every launch uses that Chromium binary
 * instead of the one Playwright resolves: for a local run against a cached
 * build, never set in CI.
 *
 * Needs the Chromium build Playwright resolves for this package. The
 * unit-test shards opt out with `FABRIC_SKIP_BROWSER_E2E=1`, and CI runs this
 * file in the real-Chromium job on Linux, the platform the worker prints on.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { crc32, deflateSync, inflateSync } from "node:zlib";
import { extractPdfPageTexts } from "@repo/rag";
import { readFigureKind } from "@repo/utils/proposal-artifact/proposal-figures";
import {
	PROPOSAL_PRINT_CLASSES,
	PROPOSAL_THEME_CLASSES,
} from "@repo/utils/proposal-artifact/proposal-theme";
import {
	buildProposalThemeTokens,
	resolveThemePaint,
} from "@repo/utils/proposal-artifact/theme-tokens";
import { chromium } from "playwright";
import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";
import { generatePDFActivity } from "../src/activities/frame-export/generate-pdf";
import { printProposalPdf } from "../src/activities/proposal-export/print-pdf";
import {
	PRINT_COLUMN_PX,
	renderExportDiagrams,
} from "../src/activities/proposal-export/render-diagrams";
import {
	exportLaunchOptions,
	withExportBrowser,
} from "../src/lib/proposal-export/browser";
import {
	buildThemeHtml,
	type ThemeHtmlPass,
} from "../src/lib/proposal-export/build-theme-html";
import {
	PRINT_FONTS,
	printFontFaceCss,
} from "../src/lib/proposal-export/fonts";
import {
	exportDiagramCaptions,
	prepareExportMarkdown,
} from "../src/lib/proposal-export/markdown";
import type {
	ExportRaster,
	ExportThemeTokens,
	ProposalExportWarning,
} from "../src/lib/proposal-export/types";
import {
	BROKEN_FENCE_TEXT,
	COVER_LEAD,
	FULL_FIGURE_COUNT,
	FULL_PROPOSAL,
	FULL_SECTIONS,
	FULL_TEMPLATE_FENCES,
	FULL_TITLE,
	GENERATED_FIGURE_COUNT,
	GENERATED_PROPOSAL,
	GENERATED_SECTIONS,
	GENERATED_TITLE,
	PROPOSER_NAME,
	RECIPIENT_NAME,
} from "./fixtures/proposal-print-fixtures";

// The package barrel also loads the database client, which the real-Chromium
// job does not generate; the PDF reader the printer uses stands alone.
vi.mock("@repo/rag", async () => {
	const { extractPdfPageTexts } = await import(
		"../../rag/lib/extraction/extractors/pdf-page-texts"
	);
	return { extractPdfPageTexts };
});

// A local run may point every launch at a Chromium already on disk.
vi.mock("playwright", async (importOriginal) => {
	const actual = await importOriginal<typeof import("playwright")>();
	const executablePath = process.env.PROPOSAL_PRINT_CHROMIUM_PATH;
	if (!executablePath) {
		return actual;
	}
	const launch = actual.chromium.launch.bind(actual.chromium);
	return {
		...actual,
		chromium: Object.create(actual.chromium, {
			launch: {
				value: (options: Parameters<typeof launch>[0] = {}) =>
					launch({ ...options, executablePath }),
			},
		}),
	};
});

const SKIP_BROWSER_E2E = process.env.FABRIC_SKIP_BROWSER_E2E === "1";
const ARTIFACT_DIR = process.env.PROPOSAL_PRINT_ARTIFACT_DIR;

const DATE_LABEL = "October 23, 2026";
const PRINT_BUDGET_MS = 120_000;
/** A fixture's diagrams, measurement and two-pass print together. */
const FIXTURE_BUDGET_MS = 240_000;

/** The US Letter page in CSS pixels. */
const LETTER_PX = { width: 816, height: 1056 };
const FIGURE_WIDTH_PX = 662;
const MIN_FIGURE_TEXT_PX = 12;
/** Sub-pixel slack for layout rounding. */
const EPSILON_PX = 1;

function pngChunk(type: string, data: Buffer): Buffer {
	const length = Buffer.alloc(4);
	length.writeUInt32BE(data.length);
	const typed = Buffer.concat([Buffer.from(type, "latin1"), data]);
	const checksum = Buffer.alloc(4);
	checksum.writeUInt32BE(crc32(typed) >>> 0);
	return Buffer.concat([length, typed, checksum]);
}

/** An opaque PNG of one colour. */
function solidPng(
	width: number,
	height: number,
	[red, green, blue]: [number, number, number],
): ExportRaster {
	const header = Buffer.alloc(13);
	header.writeUInt32BE(width, 0);
	header.writeUInt32BE(height, 4);
	header[8] = 8;
	header[9] = 2;
	const row = Buffer.alloc(1 + width * 3);
	for (let x = 0; x < width; x++) {
		row[1 + x * 3] = red;
		row[2 + x * 3] = green;
		row[3 + x * 3] = blue;
	}
	const pixels = Buffer.concat(Array.from({ length: height }, () => row));
	const bytes = Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		pngChunk("IHDR", header),
		pngChunk("IDAT", deflateSync(pixels)),
		pngChunk("IEND", Buffer.alloc(0)),
	]);
	return { mimeType: "image/png", bytes, width, height };
}

function exportTokens(): ExportThemeTokens {
	const base = buildProposalThemeTokens({
		organization: { name: "Example Org", logoKey: null },
		style: { primaryColor: "#0f766e", accentColors: [] },
		brandKit: null,
		vendorSite: null,
		recipient: { name: "Example Client", logoKey: null, colors: [] },
	});
	const asset = (value: ExportRaster) => ({
		value,
		source: "BRAND_KIT" as const,
	});
	return {
		...base,
		proposer: {
			...base.proposer,
			logo: asset(solidPng(200, 200, [160, 20, 20])),
			hero: asset(solidPng(1600, 566, [20, 100, 140])),
		},
		recipient: {
			...base.recipient,
			logo: { value: solidPng(400, 400, [40, 40, 40]), source: "MANUAL" },
		},
	} as ExportThemeTokens;
}

/** One sRGB channel byte as linear light. */
function linear(channel: number): number {
	const value = channel / 255;
	return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

/**
 * An image drawn from SVG by sharp, measured as the export measures brand
 * assets: a logo by its mean luminance over its opaque pixels, the hero by
 * its bright end (the 90th percentile).
 */
async function rasterFromSvg(
	svg: string,
	measure: "logo" | "hero",
): Promise<ExportRaster> {
	const bytes = await sharp(Buffer.from(svg)).png().toBuffer();
	const { data, info } = await sharp(bytes)
		.ensureAlpha()
		.raw()
		.toBuffer({ resolveWithObject: true });
	const luminances: number[] = [];
	let sum = 0;
	let weight = 0;
	let opaque = true;
	for (let offset = 0; offset < data.length; offset += 4) {
		const alpha = (data[offset + 3] ?? 0) / 255;
		if (alpha < 1) {
			opaque = false;
		}
		const luminance =
			0.2126 * linear(data[offset] ?? 0) +
			0.7152 * linear(data[offset + 1] ?? 0) +
			0.0722 * linear(data[offset + 2] ?? 0);
		sum += luminance * alpha;
		weight += alpha;
		if (alpha > 0.5) {
			luminances.push(luminance);
		}
	}
	luminances.sort((a, b) => a - b);
	const luminance =
		measure === "logo"
			? sum / weight
			: (luminances[Math.floor(luminances.length * 0.9)] ?? 1);
	return {
		mimeType: "image/png",
		bytes,
		width: info.width,
		height: info.height,
		luminance,
		...(measure === "logo" ? { opaque } : {}),
	};
}

/** A synthetic hero: a teal-to-navy field with soft shapes. */
const HERO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="566" viewBox="0 0 1600 566">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#2a8f8a"/><stop offset="1" stop-color="#14284b"/></linearGradient></defs>
<rect width="1600" height="566" fill="url(#g)"/>
<circle cx="1250" cy="160" r="210" fill="#5fc4b8" fill-opacity="0.35"/>
<circle cx="980" cy="420" r="160" fill="#e0f2ef" fill-opacity="0.18"/>
<path d="M0 470 C 400 380, 800 560, 1600 420 L 1600 566 L 0 566 Z" fill="#0b1830" fill-opacity="0.5"/>
</svg>`;

/** A light mark on transparency, drawn for a dark background. */
const PROPOSER_LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="120" viewBox="0 0 480 120">
<rect x="0" y="20" width="80" height="80" rx="18" fill="#ffffff"/>
<rect x="104" y="34" width="360" height="22" rx="6" fill="#ffffff"/>
<rect x="104" y="66" width="240" height="20" rx="6" fill="#d8e6f2"/>
</svg>`;

/** A dark mark on transparency, drawn for a light background. */
const RECIPIENT_LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="320" viewBox="0 0 320 320">
<circle cx="160" cy="160" r="140" fill="#12233f"/>
<path d="M80 200 L160 90 L240 200 Z" fill="#2f6db0"/>
</svg>`;

async function fixtureTokens(): Promise<ExportThemeTokens> {
	const base = buildProposalThemeTokens({
		organization: { name: PROPOSER_NAME, logoKey: null },
		style: { primaryColor: "#0f766e", accentColors: [] },
		brandKit: null,
		vendorSite: null,
		recipient: { name: RECIPIENT_NAME, logoKey: null, colors: [] },
	});
	const hero = await rasterFromSvg(HERO_SVG, "hero");
	const openerCopy: ExportRaster = {
		...hero,
		bytes: await sharp(hero.bytes).resize({ width: 800 }).png().toBuffer(),
		width: 800,
		height: Math.round((800 * hero.height) / hero.width),
	};
	return {
		...base,
		proposer: {
			...base.proposer,
			logo: {
				value: await rasterFromSvg(PROPOSER_LOGO_SVG, "logo"),
				source: "BRAND_KIT",
			},
			hero: { value: { ...hero, openerCopy }, source: "BRAND_KIT" },
		},
		recipient: {
			...base.recipient,
			logo: {
				value: await rasterFromSvg(RECIPIENT_LOGO_SVG, "logo"),
				source: "MANUAL",
			},
		},
	} as ExportThemeTokens;
}

const PARAGRAPH =
	"Software teams effectively identify the difficult parts of a workflow first, then focus the pilot on the stages that matter most to the people who run it.";

const MARKDOWN = [
	"## 1. Executive summary",
	"",
	PARAGRAPH,
	"",
	PARAGRAPH,
	"",
	"## 2. Delivery approach",
	"",
	PARAGRAPH,
	"",
	"- Map the selected workflow and its current tools.",
	"- Define the context the pilot needs.",
	"- Configure and validate the agreed scope.",
	"",
].join("\n");

async function printExample(): Promise<Buffer> {
	const prepared = prepareExportMarkdown(MARKDOWN);
	const tokens = exportTokens();
	return withExportBrowser(Date.now() + PRINT_BUDGET_MS, async (browser) => {
		const printed = await printProposalPdf({
			browser,
			buildHtml: (pass) =>
				buildThemeHtml({
					prepared,
					diagrams: [],
					images: new Map(),
					tokens,
					projectId: "project-example-1",
					documentId: "document-example-1",
					title: "Example Proposal",
					dateLabel: DATE_LABEL,
					pass,
				}),
		});
		return printed.pdf;
	});
}

/**
 * A synthetic frame of plain paragraphs, printed by the frame export.
 *
 * The paragraphs are set in the committed Inter through an `html` block's
 * own `<style>` (frame HTML keeps its stylesheets, and a `data:` font loads
 * with every request aborted), the same faces the Proposal prints in. The
 * template's system stack would fall back to whatever the host has: on the
 * Linux runner, Liberation Sans, which Chromium writes as whole text runs
 * with no per-glyph move, so the spacing check would have nothing to read.
 * Chromium starts a new run at each kerning pair, about twenty to a
 * paragraph, so kerning is on, as the Proposal sets it, and there are
 * enough paragraphs for the check's floor.
 */
async function printFrameExample(): Promise<Buffer> {
	const fontBlock = {
		type: "html",
		content: `<style>\n${printFontFaceCss()}\nbody { font-family: "${PRINT_FONTS.body}", sans-serif; font-kerning: normal; }\n</style>`,
	};
	const content = {
		title: "Example Frame",
		description: "A frame for Example Client",
		blocks: [
			fontBlock,
			...Array.from({ length: 16 }, () => ({
				type: "markdown",
				content: PARAGRAPH,
			})),
		],
		theme: { mode: "light" },
	} as unknown as Parameters<typeof generatePDFActivity>[0]["content"];
	return generatePDFActivity({ content, orientation: "portrait" });
}

/** The share of `advances` that sit on a whole pixel. */
function wholePixelShare(advances: number[]): number {
	const whole = advances.filter(
		(advance) => Math.abs(advance - Math.round(advance)) < 0.005,
	);
	return whole.length / advances.length;
}

/**
 * Every horizontal move inside a text object of the PDF: Chromium writes one
 * `x 0 Td` before each glyph run, so these are the printed glyph advances.
 */
function textAdvances(pdf: Buffer): number[] {
	const source = pdf.toString("latin1");
	const advances: number[] = [];
	for (const match of source.matchAll(/stream\r?\n/g)) {
		const start = (match.index ?? 0) + match[0].length;
		const end = source.indexOf("endstream", start);
		if (end < 0) {
			continue;
		}
		let content: string;
		try {
			content = inflateSync(pdf.subarray(start, end)).toString("latin1");
		} catch {
			continue;
		}
		for (const text of content.matchAll(/BT([\s\S]*?)ET/g)) {
			for (const move of (text[1] ?? "").matchAll(
				/(-?\d+(?:\.\d+)?) 0 Td/g,
			)) {
				advances.push(Number(move[1]));
			}
		}
	}
	return advances;
}

/** Every embedded font's name, without a subset's `ABCDEF+` tag. */
function embeddedFontNames(pdf: Buffer): string[] {
	const names = new Set<string>();
	for (const match of pdf
		.toString("latin1")
		.matchAll(/\/FontName\s*\/(?:[A-Z]{6}\+)?([A-Za-z0-9_-]+)/g)) {
		names.add(match[1] ?? "");
	}
	return [...names];
}

const compact = (text: string) => text.replace(/\s+/g, "");

/** How often `needle` occurs in `haystack`. */
function occurrences(haystack: string, needle: string): number {
	return haystack.split(needle).length - 1;
}

/** Writes a printed PDF for review when an artifact folder is set. */
function keepArtifact(name: string, pdf: Buffer): void {
	if (!ARTIFACT_DIR) {
		return;
	}
	mkdirSync(ARTIFACT_DIR, { recursive: true });
	writeFileSync(join(ARTIFACT_DIR, name), pdf);
}

/** A promise made on first use and shared after. */
function once<T>(make: () => Promise<T>): () => Promise<T> {
	let made: Promise<T> | null = null;
	return () => {
		made ??= make();
		return made;
	};
}

interface FigureTextProblem {
	figure: number;
	text: string;
	problem: string;
}

interface PrintGeometry {
	cover: {
		width: number;
		height: number;
		titleLines: number;
		bodyBottom: number;
		bodyContentBottom: number;
		bodyClipped: boolean;
		partiesTop: number;
	};
	figures: {
		figure: number;
		width: number;
		smallestTextPx: number;
		texts: number;
	}[];
	problems: FigureTextProblem[];
}

/**
 * The print page laid out in a throwaway page with JavaScript on, only to
 * measure it: the cover at the Letter page's width, then the figure
 * templates at the print column's width. Nothing loads; every request is
 * aborted, as on the export's own pages.
 */
async function measurePrintPage(
	html: string,
	templateFigures: readonly number[],
): Promise<PrintGeometry> {
	const browser = await chromium.launch(exportLaunchOptions(PRINT_BUDGET_MS));
	try {
		const context = await browser.newContext({
			viewport: LETTER_PX,
			javaScriptEnabled: true,
			offline: true,
		});
		await context.route("**/*", (route) => route.abort("blockedbyclient"));
		const page = await context.newPage();
		await page.setContent(html, { waitUntil: "load" });
		await page.evaluate(() => document.fonts.ready.then(() => undefined));

		const cover = await page.evaluate(
			(classes) => {
				const find = (name: string) => {
					const element = document.querySelector(`.${name}`);
					if (!element) {
						throw new Error(`missing .${name}`);
					}
					return element as HTMLElement;
				};
				const section = find(classes.cover).getBoundingClientRect();
				const body = find(classes.coverBody);
				const title = find(classes.coverTitle);
				const lineHeight = Number.parseFloat(
					getComputedStyle(title).lineHeight,
				);
				const contentBottom = Math.max(
					...Array.from(body.children).map(
						(child) => child.getBoundingClientRect().bottom,
					),
				);
				return {
					width: section.width,
					height: section.height,
					titleLines:
						title.getBoundingClientRect().height / lineHeight,
					bodyBottom: body.getBoundingClientRect().bottom,
					bodyContentBottom: contentBottom,
					bodyClipped: body.scrollHeight > body.clientHeight + 0.5,
					partiesTop: find(
						classes.coverParties,
					).getBoundingClientRect().top,
				};
			},
			{
				cover: PROPOSAL_THEME_CLASSES.cover,
				coverBody: PROPOSAL_PRINT_CLASSES.coverBody,
				coverTitle: PROPOSAL_PRINT_CLASSES.coverTitle,
				coverParties: PROPOSAL_PRINT_CLASSES.coverParties,
			},
		);

		await page.setViewportSize({
			width: Math.ceil(PRINT_COLUMN_PX),
			height: LETTER_PX.height,
		});
		const measured = await page.evaluate(
			({ figures, epsilon }) => {
				const problems: {
					figure: number;
					text: string;
					problem: string;
				}[] = [];
				const inside = (inner: DOMRect, outer: DOMRect) =>
					inner.left >= outer.left - epsilon &&
					inner.right <= outer.right + epsilon &&
					inner.top >= outer.top - epsilon &&
					inner.bottom <= outer.bottom + epsilon;
				const overlaps = (a: DOMRect, b: DOMRect) =>
					Math.min(a.right, b.right) - Math.max(a.left, b.left) >
						epsilon &&
					Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) >
						epsilon;
				const results = figures.map((figure) => {
					const svg = document.getElementById(`pa-diagram-${figure}`);
					if (!(svg instanceof SVGSVGElement)) {
						throw new Error(`missing figure ${figure}`);
					}
					const box = svg.getBoundingClientRect();
					const scale = box.width / svg.viewBox.baseVal.width;
					const rects = Array.from(svg.querySelectorAll("rect")).map(
						(rect) => rect.getBoundingClientRect(),
					);
					const texts = Array.from(svg.querySelectorAll("text"));
					let smallest = Number.POSITIVE_INFINITY;
					for (const text of texts) {
						const label = text.textContent ?? "";
						const size =
							Number.parseFloat(getComputedStyle(text).fontSize) *
							scale;
						smallest = Math.min(smallest, size);
						const bounds = text.getBoundingClientRect();
						if (!inside(bounds, box)) {
							problems.push({
								figure,
								text: label,
								problem: "outside the figure",
							});
						}
						// A box the text touches must hold all of it: text that
						// spills over a box edge overlaps it without being inside.
						for (const rect of rects) {
							if (
								overlaps(bounds, rect) &&
								!inside(bounds, rect)
							) {
								problems.push({
									figure,
									text: label,
									problem: `crosses a box edge (${Math.round(rect.left - box.left)},${Math.round(rect.top - box.top)} ${Math.round(rect.width)}x${Math.round(rect.height)})`,
								});
							}
						}
					}
					return {
						figure,
						width: box.width,
						smallestTextPx: smallest,
						texts: texts.length,
					};
				});
				return { figures: results, problems };
			},
			{ figures: [...templateFigures], epsilon: EPSILON_PX },
		);
		return { cover, ...measured };
	} finally {
		await browser.close().catch(() => undefined);
	}
}

interface PrintedFixture {
	pdf: Buffer;
	pages: string[];
	geometry: PrintGeometry;
	diagramWarnings: ProposalExportWarning[];
	templateFigures: number[];
}

/**
 * A fixture through the export's own path: Main prepared, its diagrams
 * drawn, the page measured, then printed in two passes.
 */
async function printFixture(
	markdown: string,
	title: string,
	artifact: string,
): Promise<PrintedFixture> {
	const prepared = prepareExportMarkdown(markdown);
	const tokens = await fixtureTokens();
	const diagrams = await renderExportDiagrams({
		sources: prepared.diagramSources,
		captions: exportDiagramCaptions(prepared),
		paint: resolveThemePaint(tokens),
		browser: null,
		withPng: false,
		deadline: Date.now() + PRINT_BUDGET_MS,
	});
	const buildHtml = (pass: ThemeHtmlPass) =>
		buildThemeHtml({
			prepared,
			diagrams: diagrams.diagrams,
			images: new Map(),
			tokens,
			projectId: "project-example-1",
			documentId: "document-example-1",
			title,
			dateLabel: DATE_LABEL,
			pass,
		});
	// Figure ids follow the fences' order, 1-based.
	const templateFigures = prepared.diagramSources.flatMap((source, index) =>
		readFigureKind(source) !== null &&
		diagrams.diagrams[index]?.kind === "svg"
			? [index + 1]
			: [],
	);
	const geometry = await measurePrintPage(
		buildHtml({ kind: "final", pageNumbers: null }).html,
		templateFigures,
	);
	const pdf = await withExportBrowser(
		Date.now() + PRINT_BUDGET_MS,
		async (browser) => (await printProposalPdf({ browser, buildHtml })).pdf,
	);
	keepArtifact(artifact, pdf);
	const { pages } = await extractPdfPageTexts(pdf);
	return {
		pdf,
		pages,
		geometry,
		diagramWarnings: diagrams.warnings,
		templateFigures,
	};
}

const fullPrint = once(() =>
	printFixture(FULL_PROPOSAL, FULL_TITLE, "full.pdf"),
);
const generatedPrint = once(() =>
	printFixture(GENERATED_PROPOSAL, GENERATED_TITLE, "generated.pdf"),
);
const framePrint = once(async () => {
	const pdf = await printFrameExample();
	keepArtifact("frame.pdf", pdf);
	return pdf;
});

/** A heading as the contents page should list it: its typed number gone. */
const withoutNumber = (heading: string) => heading.replace(/^\d+\.\s+/, "");

describe.skipIf(SKIP_BROWSER_E2E)("Proposal PDF printed by Chromium", () => {
	it(
		"prints the cover alone on page 1, with its date and no running header or footer",
		async () => {
			const { pages } = await extractPdfPageTexts(await printExample());

			expect(pages.length).toBeGreaterThanOrEqual(2);
			const cover = compact(pages[0] ?? "");
			expect(cover).toContain(compact(DATE_LABEL));
			expect(cover).not.toContain("Page1of");
			expect(compact(pages[1] ?? "")).toContain("Page2of");
		},
		PRINT_BUDGET_MS,
	);

	it(
		"keeps the font's own glyph spacing instead of rounding it to whole pixels",
		async () => {
			const advances = textAdvances(await printExample());

			// Hinted Linux print rounds 85-90% of them; unhinted text almost none.
			expect(advances.length).toBeGreaterThan(200);
			expect(wholePixelShare(advances)).toBeLessThan(0.3);
		},
		PRINT_BUDGET_MS,
	);
});

describe.skipIf(SKIP_BROWSER_E2E)(
	"Proposal fixtures printed by Chromium",
	() => {
		const fixtures = [
			{
				name: "full",
				print: fullPrint,
				sections: FULL_SECTIONS,
				figures: FULL_FIGURE_COUNT,
				templates: FULL_TEMPLATE_FENCES.length,
			},
			{
				name: "generated-shape",
				print: generatedPrint,
				sections: GENERATED_SECTIONS,
				figures: GENERATED_FIGURE_COUNT,
				templates: GENERATED_FIGURE_COUNT,
			},
		] as const;

		it(
			"draws the full fixture's diagrams with the expected warnings only",
			async () => {
				const printed = await fullPrint();

				// The broken fence left out, the gantt a placeholder, and no
				// diagram printing its labels below the floor.
				expect(printed.diagramWarnings).toEqual([
					{ code: "DIAGRAM_PLACEHOLDER", count: 1 },
					{ code: "DIAGRAM_NOT_PRINTABLE", count: 1 },
				]);
				expect(printed.templateFigures).toEqual(
					FULL_TEMPLATE_FENCES.map((index) => index + 1),
				);
				expect(Array.from(COVER_LEAD)).toHaveLength(320);
			},
			FIXTURE_BUDGET_MS,
		);

		it(
			"lays the cover out as a full Letter page whose body ends above the parties",
			async () => {
				const { cover } = (await fullPrint()).geometry;

				expect(cover.width).toBeCloseTo(LETTER_PX.width, 0);
				expect(cover.height).toBeCloseTo(LETTER_PX.height, 0);
				// The fixture's title fills the three lines the cover allows.
				expect(cover.titleLines).toBeGreaterThan(2.5);
				expect(cover.titleLines).toBeLessThan(3.5);
				expect(cover.bodyClipped).toBe(false);
				expect(cover.bodyContentBottom).toBeLessThanOrEqual(
					cover.bodyBottom + EPSILON_PX,
				);
				expect(cover.bodyBottom).toBeLessThan(cover.partiesTop);
			},
			FIXTURE_BUDGET_MS,
		);

		for (const fixture of fixtures) {
			it(
				`draws the ${fixture.name} fixture's figure templates at the column width, with text of 12 px or more inside its boxes`,
				async () => {
					const { geometry, templateFigures } = await fixture.print();

					expect(templateFigures).toHaveLength(fixture.templates);
					expect(geometry.figures).toHaveLength(fixture.templates);
					for (const figure of geometry.figures) {
						expect(
							figure.width,
							`figure ${figure.figure}`,
						).toBeCloseTo(FIGURE_WIDTH_PX, 0);
						expect(figure.texts).toBeGreaterThan(0);
						expect(
							figure.smallestTextPx,
							`figure ${figure.figure}`,
						).toBeGreaterThanOrEqual(MIN_FIGURE_TEXT_PX);
					}
					expect(geometry.problems).toEqual([]);
				},
				FIXTURE_BUDGET_MS,
			);

			it(
				`embeds the three print faces in the ${fixture.name} fixture`,
				async () => {
					const fonts = embeddedFontNames(
						(await fixture.print()).pdf,
					);

					expect(fonts).toContain("Poppins-Bold");
					expect(
						fonts.some((name) => name.startsWith("JetBrainsMono")),
					).toBe(true);
					expect(
						fonts.some((name) => /^Inter(?:\b|-)/.test(name)),
					).toBe(true);
				},
				FIXTURE_BUDGET_MS,
			);

			it(
				`prints no page number on the ${fixture.name} fixture's cover, and each section once on the contents page without its typed number`,
				async () => {
					const { pages } = await fixture.print();

					expect(compact(pages[0] ?? "")).not.toMatch(/Page/i);
					const contents = compact(pages[1] ?? "");
					expect(contents.toUpperCase()).toContain("CONTENTS");
					for (const section of fixture.sections) {
						expect(
							occurrences(
								contents,
								compact(withoutNumber(section.heading)),
							),
							section.heading,
						).toBe(1);
						expect(contents).not.toContain(
							compact(section.heading),
						);
					}
				},
				FIXTURE_BUDGET_MS,
			);

			it(
				`numbers the ${fixture.name} fixture's figures in order`,
				async () => {
					const text = compact(
						(await fixture.print()).pages.join("\n"),
					);

					let previous = -1;
					for (let number = 1; number <= fixture.figures; number++) {
						const at = text.indexOf(`Figure${number}.`);
						expect(at, `Figure ${number}.`).toBeGreaterThan(
							previous,
						);
						previous = at;
					}
					expect(text).not.toContain(`Figure${fixture.figures + 1}.`);
				},
				FIXTURE_BUDGET_MS,
			);

			it(
				`keeps the font's own glyph spacing in the ${fixture.name} fixture`,
				async () => {
					const advances = textAdvances((await fixture.print()).pdf);

					expect(advances.length).toBeGreaterThan(200);
					expect(wholePixelShare(advances)).toBeLessThan(0.3);
				},
				FIXTURE_BUDGET_MS,
			);
		}

		it(
			"leaves the broken diagram out of the full fixture",
			async () => {
				const text = compact((await fullPrint()).pages.join("\n"));

				for (const part of BROKEN_FENCE_TEXT) {
					expect(text).not.toContain(compact(part));
				}
				// The gantt after it still prints, as a numbered placeholder.
				expect(text).toContain(
					compact(
						`Figure ${FULL_FIGURE_COUNT}. Pilot schedule by workstream`,
					),
				);
			},
			FIXTURE_BUDGET_MS,
		);
	},
);

describe.skipIf(SKIP_BROWSER_E2E)("Frame PDF printed by Chromium", () => {
	it(
		"keeps the font's own glyph spacing instead of rounding it to whole pixels",
		async () => {
			const pdf = await framePrint();
			const advances = textAdvances(pdf);

			// Printed in the committed face, not the host's fallback.
			expect(
				embeddedFontNames(pdf).some((name) =>
					/^Inter(?:\b|-)/.test(name),
				),
			).toBe(true);
			expect(advances.length).toBeGreaterThan(200);
			expect(wholePixelShare(advances)).toBeLessThan(0.3);
		},
		PRINT_BUDGET_MS,
	);
});
