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
 * Needs the Chromium build Playwright resolves for this package. The
 * unit-test shards opt out with `FABRIC_SKIP_BROWSER_E2E=1`, and CI runs this
 * file in the real-Chromium job on Linux, the platform the worker prints on.
 */
import { crc32, deflateSync, inflateSync } from "node:zlib";
import { extractPdfPageTexts } from "@repo/rag";
import { buildProposalThemeTokens } from "@repo/utils/proposal-artifact/theme-tokens";
import { describe, expect, it, vi } from "vitest";
import { printProposalPdf } from "../src/activities/proposal-export/print-pdf";
import { withExportBrowser } from "../src/lib/proposal-export/browser";
import { buildThemeHtml } from "../src/lib/proposal-export/build-theme-html";
import { prepareExportMarkdown } from "../src/lib/proposal-export/markdown";
import type {
	ExportRaster,
	ExportThemeTokens,
} from "../src/lib/proposal-export/types";

// The package barrel also loads the database client, which the real-Chromium
// job does not generate; the PDF reader the printer uses stands alone.
vi.mock("@repo/rag", async () => {
	const { extractPdfPageTexts } = await import(
		"../../rag/lib/extraction/extractors/pdf-page-texts"
	);
	return { extractPdfPageTexts };
});

const SKIP_BROWSER_E2E = process.env.FABRIC_SKIP_BROWSER_E2E === "1";

const DATE_LABEL = "October 23, 2026";
const PRINT_BUDGET_MS = 120_000;

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

const compact = (text: string) => text.replace(/\s+/g, "");

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
			const whole = advances.filter(
				(advance) => Math.abs(advance - Math.round(advance)) < 0.005,
			);

			// Hinted Linux print rounds 85-90% of them; unhinted text almost none.
			expect(advances.length).toBeGreaterThan(200);
			expect(whole.length / advances.length).toBeLessThan(0.3);
		},
		PRINT_BUDGET_MS,
	);
});
