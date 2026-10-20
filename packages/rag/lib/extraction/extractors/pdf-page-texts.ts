/**
 * Per-page text of a PDF, for code that needs to know which page something
 * landed on (the Proposal export's contents page, Fizzy #2946).
 *
 * pdf-parse is a dependency of this package only and is not hoisted, so the
 * `pagerender` callback that captures each page's text has to live here.
 */

import pdfParse from "pdf-parse";

/** A pdf.js text item, as much of it as the joiner reads. */
interface PdfTextItem {
	str: string;
	transform: number[];
}

/** The page proxy pdf-parse hands `pagerender`, as much of it as is read. */
interface PdfPageData {
	pageIndex: number;
	getTextContent(options: {
		normalizeWhitespace: boolean;
		disableCombineTextItems: boolean;
	}): Promise<{ items: PdfTextItem[] }>;
}

export interface PdfPageTexts {
	pageCount: number;
	/** Each page's text, index 0 is page 1. */
	pages: string[];
}

/**
 * The text of every page, joined the way pdf-parse joins a page by default:
 * items on one baseline run together, a new baseline starts a new line.
 * A page with no text is an empty string.
 */
export async function extractPdfPageTexts(
	buffer: Buffer,
): Promise<PdfPageTexts> {
	const pages: string[] = [];
	// Always pass an options object: without one, pdf-parse 1.1.4 never
	// applies its defaults and takes a strict-XRef path that rejects valid
	// PDFs (see `local-pdf.ts`).
	const result = await pdfParse(buffer, {
		pagerender: async (pageData: PdfPageData) => {
			const content = await pageData.getTextContent({
				normalizeWhitespace: false,
				disableCombineTextItems: false,
			});
			let text = "";
			let lastY: number | undefined;
			for (const item of content.items) {
				const y = item.transform[5];
				text +=
					lastY === undefined || lastY === y
						? item.str
						: `\n${item.str}`;
				lastY = y;
			}
			pages[pageData.pageIndex] = text;
			return text;
		},
	});
	const pageCount = result.numpages;
	return {
		pageCount,
		pages: Array.from(
			{ length: pageCount },
			(_, index) => pages[index] ?? "",
		),
	};
}
