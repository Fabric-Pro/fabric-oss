/**
 * Printing the Proposal's theme page to PDF (Fizzy #2946): the print options
 * defer to the page's CSS, the page prints twice so the contents page can
 * carry each section's page number (read back from the first print's
 * markers), a failed lookup prints the contents without numbers and says so,
 * and a document longer than the page budget fails for good.
 *
 * Mocked: `@repo/rag`'s `extractPdfPageTexts` (the PDF text layer) and the
 * browser, whose page returns a distinct buffer per print. The marker text
 * comes from the real `pageMarkerText`, so the lookup reads exactly what the
 * page builder writes.
 */

import { ApplicationFailure } from "@temporalio/common";
import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";

const { extractPdfPageTexts } = vi.hoisted(() => ({
	extractPdfPageTexts: vi.fn(),
}));

vi.mock("@repo/rag", () => ({ extractPdfPageTexts }));

import type { ExportBrowser } from "../../../lib/proposal-export/browser";
import {
	type ExportSection,
	pageMarkerText,
	type ThemeHtmlPass,
} from "../../../lib/proposal-export/build-theme-html";
import { PROPOSAL_EXPORT_LIMITS } from "../../../lib/proposal-export/types";
import {
	locateSections,
	PROPOSAL_PDF_OPTIONS,
	printProposalPdf,
} from "../print-pdf";

const LOCATE_HTML = "<html><body>locate pass</body></html>";
const FINAL_HTML = "<html><body>final pass</body></html>";
const LOCATE_PDF = Buffer.from("%PDF-1.7 example locate print");
const FINAL_PDF = Buffer.from("%PDF-1.7 example final print");

function sections(count: number): ExportSection[] {
	return Array.from({ length: count }, (_, i) => ({
		index: i + 1,
		id: `pa-section-${i + 1}`,
		title: `Example Section ${i + 1}`,
	}));
}

interface Harness {
	browser: ExportBrowser;
	newPage: Mock;
	setContent: Mock;
	pdf: Mock;
	buildHtml: Mock<
		(pass: ThemeHtmlPass) => { html: string; sections: ExportSection[] }
	>;
}

function harness(sectionList: ExportSection[]): Harness {
	const prints = [LOCATE_PDF, FINAL_PDF];
	const setContent = vi.fn(async () => undefined);
	const pdf = vi.fn(async () => {
		const next = prints.shift();
		if (!next) {
			throw new Error("printed more than twice");
		}
		// Playwright hands back a Buffer; a Uint8Array view proves the
		// printer copies it into one either way.
		return new Uint8Array(next);
	});
	const page = { setContent, pdf };
	const newPage = vi.fn(async () => page);
	const buildHtml = vi.fn((pass: ThemeHtmlPass) => ({
		html: pass.kind === "locate" ? LOCATE_HTML : FINAL_HTML,
		sections: sectionList,
	}));
	return {
		browser: { newPage, blockedRequests: 0 } as unknown as ExportBrowser,
		newPage,
		setContent,
		pdf,
		buildHtml,
	};
}

/** Text layers by print: the locate print's pages, then the final print's. */
function textLayers(
	locate: { pageCount?: number; pages: string[] },
	final: { pageCount: number } = { pageCount: locate.pages.length },
): void {
	extractPdfPageTexts.mockImplementation(async (buffer: Buffer) => {
		if (buffer.equals(LOCATE_PDF)) {
			return {
				pageCount: locate.pageCount ?? locate.pages.length,
				pages: locate.pages,
			};
		}
		if (buffer.equals(FINAL_PDF)) {
			return {
				pageCount: final.pageCount,
				pages: Array.from({ length: final.pageCount }, () => ""),
			};
		}
		throw new Error("unexpected PDF");
	});
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
	try {
		await promise;
	} catch (error) {
		return error;
	}
	throw new Error("expected the promise to reject");
}

function expectTooManyPages(error: unknown): void {
	expect(error).toBeInstanceOf(ApplicationFailure);
	expect(error).toMatchObject({
		type: "TOO_MANY_PAGES",
		nonRetryable: true,
	});
}

beforeEach(() => {
	extractPdfPageTexts.mockReset();
});

describe("printProposalPdf: print options", () => {
	it("prints with the CSS page size, backgrounds, the outline and tags, and no header or footer", async () => {
		expect(PROPOSAL_PDF_OPTIONS).toEqual({
			preferCSSPageSize: true,
			printBackground: true,
			displayHeaderFooter: false,
			outline: true,
			tagged: true,
		});
		const h = harness(sections(1));
		textLayers({
			pages: ["Cover", `${pageMarkerText(1)}Example Section 1`],
		});

		await printProposalPdf({ browser: h.browser, buildHtml: h.buildHtml });

		expect(h.pdf).toHaveBeenCalledTimes(2);
		for (const call of h.pdf.mock.calls) {
			expect(call[0]).toEqual({
				preferCSSPageSize: true,
				printBackground: true,
				displayHeaderFooter: false,
				outline: true,
				tagged: true,
			});
		}
	});

	it("loads each pass's HTML and waits for the load event, on one page", async () => {
		const h = harness(sections(1));
		textLayers({
			pages: ["Cover", `${pageMarkerText(1)}Example Section 1`],
		});

		await printProposalPdf({ browser: h.browser, buildHtml: h.buildHtml });

		expect(h.newPage).toHaveBeenCalledTimes(1);
		expect(h.setContent.mock.calls).toEqual([
			[LOCATE_HTML, { waitUntil: "load" }],
			[FINAL_HTML, { waitUntil: "load" }],
		]);
	});
});

describe("printProposalPdf: the contents page's numbers", () => {
	it("prints twice and numbers each section by the page its marker is on", async () => {
		const h = harness(sections(3));
		textLayers(
			{
				pages: [
					"Example Proposal cover",
					"Contents",
					`${pageMarkerText(1)}Example Section 1 body`,
					"continued",
					`${pageMarkerText(2)}Example Section 2`,
					`${pageMarkerText(3)}Example Section 3`,
				],
			},
			{ pageCount: 6 },
		);

		const result = await printProposalPdf({
			browser: h.browser,
			buildHtml: h.buildHtml,
		});

		expect(h.buildHtml.mock.calls).toEqual([
			[{ kind: "locate" }],
			[
				{
					kind: "final",
					pageNumbers: new Map([
						[1, 3],
						[2, 5],
						[3, 6],
					]),
				},
			],
		]);
		expect(Buffer.isBuffer(result.pdf)).toBe(true);
		expect(result.pdf.equals(FINAL_PDF)).toBe(true);
		expect(result.pageCount).toBe(6);
		expect(result.warnings).toEqual([]);
	});

	it("prints the contents without numbers, and warns for every section, when the text cannot be read", async () => {
		const h = harness(sections(3));
		extractPdfPageTexts.mockRejectedValue(
			new Error("Invalid PDF structure"),
		);

		const result = await printProposalPdf({
			browser: h.browser,
			buildHtml: h.buildHtml,
		});

		expect(h.buildHtml.mock.calls[1]).toEqual([
			{ kind: "final", pageNumbers: null },
		]);
		expect(h.pdf).toHaveBeenCalledTimes(2);
		expect(result.pdf.equals(FINAL_PDF)).toBe(true);
		// No page objects in the stand-in bytes either: the count is unknown.
		expect(result.pageCount).toBe(0);
		expect(result.warnings).toEqual([
			{ code: "CONTENTS_WITHOUT_PAGE_NUMBERS", count: 3 },
		]);
	});

	it("still holds the page budget by counting page objects when the text cannot be read", async () => {
		const h = harness(sections(1));
		const pageObjects = (count: number) =>
			Buffer.from(
				`%PDF-1.4\n${Array.from(
					{ length: count },
					(_, index) =>
						`${index + 3} 0 obj\n<</Type /Page\n/Parent 2 0 R>>\nendobj\n`,
				).join("")}2 0 obj\n<</Type /Pages /Count ${count}>>\nendobj\n`,
				"latin1",
			);
		h.pdf.mockImplementation(
			async () =>
				new Uint8Array(
					pageObjects(PROPOSAL_EXPORT_LIMITS.maxPages + 1),
				),
		);
		extractPdfPageTexts.mockRejectedValue(
			new Error("Invalid PDF structure"),
		);

		expectTooManyPages(
			await rejection(
				printProposalPdf({
					browser: h.browser,
					buildHtml: h.buildHtml,
				}),
			),
		);

		h.pdf.mockImplementation(async () => new Uint8Array(pageObjects(4)));
		const result = await printProposalPdf({
			browser: h.browser,
			buildHtml: h.buildHtml,
		});
		expect(result.pageCount).toBe(4);
	});

	it("counts page objects only, not the same words in an outline title or a link, and prefers them to the text layer", async () => {
		const h = harness(sections(0));
		const words = "/Type /Page ".repeat(
			PROPOSAL_EXPORT_LIMITS.maxPages + 5,
		);
		h.pdf.mockImplementation(
			async () =>
				new Uint8Array(
					Buffer.from(
						[
							"%PDF-1.4",
							"3 0 obj",
							"<</Type /Page",
							"/Parent 2 0 R>>",
							"endobj",
							"4 0 obj",
							"<</Type /Page",
							"/Parent 2 0 R>>",
							"endobj",
							"5 0 obj",
							`<</Title (${words})`,
							"/Parent 6 0 R>>",
							"endobj",
							"7 0 obj",
							`<</Type /Annot /A <</S /URI /URI (https://example.com/?q=${encodeURIComponent(words)} ${words})>>>>`,
							"endobj",
						].join("\n"),
						"latin1",
					),
				),
		);
		// A text layer that disagrees is not consulted while page objects
		// are found.
		extractPdfPageTexts.mockResolvedValue({
			pageCount: PROPOSAL_EXPORT_LIMITS.maxPages + 10,
			pages: [],
		});

		const result = await printProposalPdf({
			browser: h.browser,
			buildHtml: h.buildHtml,
		});
		expect(result.pageCount).toBe(2);
	});

	it("reads a marker the text layer split into pieces, as Linux print output of small text does", async () => {
		const h = harness(sections(3));
		const spaced = (text: string) => text.split("").join(" ");
		textLayers({
			pages: [
				"Cover",
				`${spaced(pageMarkerText(1))}\nExample Section 1`,
				"Body text",
				`PAEX PORTH2N 2E\n${spaced(pageMarkerText(3))} Example Section 3`,
			],
		});

		const result = await printProposalPdf({
			browser: h.browser,
			buildHtml: h.buildHtml,
		});

		expect(h.buildHtml.mock.calls[1]).toEqual([
			{
				kind: "final",
				pageNumbers: new Map([
					[1, 2],
					[2, 4],
					[3, 4],
				]),
			},
		]);
		expect(result.warnings).toEqual([]);
	});

	it("warns only for the sections whose marker was not found", async () => {
		const h = harness(sections(3));
		textLayers({
			pages: [
				"Cover",
				`${pageMarkerText(1)}Example Section 1`,
				"Example Section 2, its marker lost",
				`${pageMarkerText(3)}Example Section 3`,
			],
		});

		const result = await printProposalPdf({
			browser: h.browser,
			buildHtml: h.buildHtml,
		});

		expect(h.buildHtml.mock.calls[1]).toEqual([
			{
				kind: "final",
				pageNumbers: new Map([
					[1, 2],
					[3, 4],
				]),
			},
		]);
		expect(result.warnings).toEqual([
			{ code: "CONTENTS_WITHOUT_PAGE_NUMBERS", count: 1 },
		]);
	});

	it("prints once, with no warning, when the page has no sections", async () => {
		const h = harness([]);
		textLayers({ pages: ["Cover", "Body"] });

		const result = await printProposalPdf({
			browser: h.browser,
			buildHtml: h.buildHtml,
		});

		expect(h.buildHtml.mock.calls).toEqual([[{ kind: "locate" }]]);
		expect(h.pdf).toHaveBeenCalledTimes(1);
		expect(h.setContent).toHaveBeenCalledTimes(1);
		expect(result.pdf.equals(LOCATE_PDF)).toBe(true);
		expect(result.pageCount).toBe(2);
		expect(result.warnings).toEqual([]);
	});
});

describe("printProposalPdf: the page budget", () => {
	const tooMany = PROPOSAL_EXPORT_LIMITS.maxPages + 1;

	it("fails for good before the second print when the first is too long", async () => {
		const h = harness(sections(1));
		textLayers({
			pageCount: tooMany,
			pages: ["Cover", `${pageMarkerText(1)}Example Section 1`],
		});

		const error = await rejection(
			printProposalPdf({ browser: h.browser, buildHtml: h.buildHtml }),
		);

		expectTooManyPages(error);
		expect(h.pdf).toHaveBeenCalledTimes(1);
	});

	it("fails for good when the final print is too long", async () => {
		const h = harness(sections(1));
		textLayers(
			{ pages: ["Cover", `${pageMarkerText(1)}Example Section 1`] },
			{ pageCount: tooMany },
		);

		expectTooManyPages(
			await rejection(
				printProposalPdf({
					browser: h.browser,
					buildHtml: h.buildHtml,
				}),
			),
		);
		expect(h.pdf).toHaveBeenCalledTimes(2);
	});

	it("fails for good when a page without sections is too long", async () => {
		const h = harness([]);
		textLayers({ pageCount: tooMany, pages: ["Cover"] });

		expectTooManyPages(
			await rejection(
				printProposalPdf({
					browser: h.browser,
					buildHtml: h.buildHtml,
				}),
			),
		);
	});

	it("accepts a document of exactly the page budget", async () => {
		const h = harness([]);
		textLayers({
			pageCount: PROPOSAL_EXPORT_LIMITS.maxPages,
			pages: ["Cover"],
		});

		const result = await printProposalPdf({
			browser: h.browser,
			buildHtml: h.buildHtml,
		});
		expect(result.pageCount).toBe(PROPOSAL_EXPORT_LIMITS.maxPages);
	});
});

describe("locateSections", () => {
	it("ignores a marker beyond the section count, and a marker 0", async () => {
		extractPdfPageTexts.mockResolvedValue({
			pageCount: 3,
			pages: [
				`${pageMarkerText(1)}`,
				`${pageMarkerText(2)} PAEXPORTH2N0E`,
				`${pageMarkerText(3)}`,
			],
		});

		const located = await locateSections(LOCATE_PDF, 2);

		expect(located).toEqual({
			pageCount: 3,
			pageNumbers: new Map([
				[1, 1],
				[2, 2],
			]),
			// Every marker start is counted, matched or not.
			markersSeen: 4,
		});
	});

	it("keeps the first page a marker appears on", async () => {
		extractPdfPageTexts.mockResolvedValue({
			pageCount: 3,
			pages: [
				"Cover",
				`${pageMarkerText(1)}Example Section 1 ${pageMarkerText(2)}`,
				`${pageMarkerText(1)} repeated by a running header`,
			],
		});

		const located = await locateSections(LOCATE_PDF, 2);

		expect(located?.pageNumbers).toEqual(
			new Map([
				[1, 2],
				[2, 2],
			]),
		);
	});

	it("is null when the PDF's text cannot be read", async () => {
		extractPdfPageTexts.mockRejectedValue(
			new Error("Invalid PDF structure"),
		);

		expect(await locateSections(LOCATE_PDF, 2)).toBeNull();
	});
});
