/**
 * Print the Proposal's theme page to PDF (Fizzy #2946). Not an activity of
 * its own: the export activity calls it with the browser it opened, so the
 * PDF bytes never pass through workflow history.
 *
 * Page furniture is CSS: the theme's `@page` margin boxes draw the running
 * header and the "Page N of M" footer, and named pages lay out the cover
 * and landscape pages, so the print options only defer to the CSS page size
 * and keep backgrounds, the outline and the tagged structure.
 *
 * The contents page needs each section's page number, and Chromium has no
 * `target-counter()` to look one up. So the page prints twice. The first
 * print carries one invisible marker per section opener (zero-layout text)
 * and empty fixed-width number slots on the contents page; the markers'
 * pages are read back from that PDF's text. The second print writes the
 * numbers into the same slots and drops the markers. A slot's width never
 * changes, so filling it cannot move anything to another page. When the
 * page lookup fails, the contents page lists its sections without numbers
 * (and without slots), and the export says so with a warning.
 */

import { extractPdfPageTexts } from "@repo/rag";
import type { Page } from "playwright";
import type { ExportBrowser } from "../../lib/proposal-export/browser";
import type {
	ExportSection,
	ThemeHtmlPass,
} from "../../lib/proposal-export/build-theme-html";
import { PAGE_MARKER_PATTERN } from "../../lib/proposal-export/build-theme-html";
import { exportFailure } from "../../lib/proposal-export/failures";
import {
	PROPOSAL_EXPORT_LIMITS,
	type ProposalExportWarning,
} from "../../lib/proposal-export/types";
import { activityLogger } from "../lib/activity-logger";

/** The PDF options every print uses: the CSS decides size and margins. */
export const PROPOSAL_PDF_OPTIONS = {
	preferCSSPageSize: true,
	printBackground: true,
	displayHeaderFooter: false,
	outline: true,
	tagged: true,
} as const;

export interface PrintProposalPdfInput {
	browser: ExportBrowser;
	/** The theme page for a pass, from the print builder. */
	buildHtml: (pass: ThemeHtmlPass) => {
		html: string;
		sections: ExportSection[];
	};
}

export interface PrintedProposalPdf {
	pdf: Buffer;
	pageCount: number;
	warnings: ProposalExportWarning[];
}

/** Print the theme page, twice when it has sections to number. */
export async function printProposalPdf(
	input: PrintProposalPdfInput,
): Promise<PrintedProposalPdf> {
	const page = await input.browser.newPage();
	const locate = input.buildHtml({ kind: "locate" });
	const first = await printHtml(page, locate.html);

	// Without sections there is no contents page and nothing to number; the
	// first print has no markers, so it is the final one.
	if (locate.sections.length === 0) {
		const pageCount = await countPages(first);
		assertPageBudget(pageCount);
		return { pdf: first, pageCount: pageCount ?? 0, warnings: [] };
	}

	const lookup = await locateSections(first, locate.sections.length);
	// Counts only, never text: enough to tell a PDF that could not be read
	// from markers that were not drawn or did not survive extraction.
	activityLogger.info("Proposal export page lookup", {
		sections: locate.sections.length,
		located: lookup?.pageNumbers.size ?? 0,
		markersSeen: lookup?.markersSeen ?? 0,
		pages: lookup?.pageCount ?? null,
		readable: lookup !== null,
	});
	if (lookup) {
		assertPageBudget(lookup.pageCount);
	}
	const final = await printHtml(
		page,
		input.buildHtml({
			kind: "final",
			pageNumbers: lookup ? lookup.pageNumbers : null,
		}).html,
	);
	const pageCount = await countPages(final);
	assertPageBudget(pageCount);

	const missing = lookup
		? locate.sections.length - lookup.pageNumbers.size
		: locate.sections.length;
	return {
		pdf: final,
		pageCount: pageCount ?? lookup?.pageCount ?? 0,
		warnings:
			missing > 0
				? [{ code: "CONTENTS_WITHOUT_PAGE_NUMBERS", count: missing }]
				: [],
	};
}

async function printHtml(page: Page, html: string): Promise<Buffer> {
	await page.setContent(html, { waitUntil: "load" });
	return Buffer.from(await page.pdf(PROPOSAL_PDF_OPTIONS));
}

/** The start every page marker shares, to count markers that did not match. */
const MARKER_PREFIX = "PAEXPORTH2N";

/**
 * Each section's page, read from the markers of the first print: the page
 * a marker's text is extracted from is the page its opener starts on. Null
 * when the PDF's text cannot be read at all.
 *
 * Markers are matched on the page's text with its whitespace removed: a
 * PDF's text layer splits a run of glyphs wherever their spacing does not
 * look like one word to it, which Chromium's Linux print output does to
 * tiny text, and a marker is letters and digits only, so dropping spaces
 * restores it without making anything else look like one.
 */
export async function locateSections(
	pdf: Buffer,
	sectionCount: number,
): Promise<{
	pageCount: number;
	pageNumbers: Map<number, number>;
	/** Marker starts seen in the text, whether or not they matched. */
	markersSeen: number;
} | null> {
	let texts: Awaited<ReturnType<typeof extractPdfPageTexts>>;
	try {
		texts = await extractPdfPageTexts(pdf);
	} catch (error) {
		activityLogger.warn(
			"Proposal export page lookup could not read the PDF",
			{
				error: error instanceof Error ? error.name : "unknown",
			},
		);
		return null;
	}
	const pageNumbers = new Map<number, number>();
	let markersSeen = 0;
	texts.pages.forEach((text, pageIndex) => {
		const compact = text.replace(/\s+/g, "");
		markersSeen += compact.split(MARKER_PREFIX).length - 1;
		for (const match of compact.matchAll(PAGE_MARKER_PATTERN)) {
			const section = Number.parseInt(match[1] ?? "", 10);
			if (
				section >= 1 &&
				section <= sectionCount &&
				!pageNumbers.has(section)
			) {
				pageNumbers.set(section, pageIndex + 1);
			}
		}
	});
	return { pageCount: texts.pageCount, pageNumbers, markersSeen };
}

/**
 * A page object as Chromium writes it, `N 0 obj` opening a line and the
 * dictionary starting with `/Type /Page`. Anchored, so the same words in an
 * outline title or a link, which the file also holds as plain text, are not
 * counted.
 */
const PAGE_OBJECT = /^\d+ \d+ obj\s*<<\s*\/Type\s*\/Page(?![A-Za-z])/gm;

/**
 * The page count of a printed PDF, from its page objects: Chromium writes
 * every page as its own object, outside any object stream, so counting them
 * avoids reading the whole file's text a second time. Its text is read only
 * when no page object is found. Null only when neither finds a page.
 */
async function countPages(pdf: Buffer): Promise<number | null> {
	const pages = (pdf.toString("latin1").match(PAGE_OBJECT) ?? []).length;
	if (pages > 0) {
		return pages;
	}
	try {
		return (await extractPdfPageTexts(pdf)).pageCount;
	} catch {
		return null;
	}
}

function assertPageBudget(pageCount: number | null): void {
	if (pageCount !== null && pageCount > PROPOSAL_EXPORT_LIMITS.maxPages) {
		throw exportFailure("TOO_MANY_PAGES");
	}
}
