/**
 * HTML-to-text extractor for .html/.htm/.xhtml uploads.
 *
 * `LocalTextExtractor` also claims `text/html`, and deliberately still does —
 * it sits behind this one in the factory's fallback chain so that HTML which
 * defeats the parser degrades to raw passthrough instead of failing the
 * upload. Do not remove its entry.
 *
 * `html-to-text` is pure JS with no native bindings, so it imports statically
 * like `mammoth` (local-docx) and `pdf-parse` (local-pdf) — both of which
 * already reach `apps/web` through the `@repo/rag` barrel without incident. It
 * needs none of the runtime-`require` escape hatch `local-xlsx` uses for
 * `exceljs`.
 *
 * Note that the `extractors/index.ts` exclusion comments are not what protects
 * that build: `factory.ts` imports `local-xlsx` directly, so it reaches the
 * barrel regardless. What protects it is the runtime `require` inside
 * `local-xlsx` itself. Registering an extractor in the factory is what pulls
 * its dependencies into every consumer — the barrel export is incidental.
 * #1684.
 */

import { logger } from "@repo/logs";
import { convert } from "html-to-text";
import type { ExtractionResult, IDocumentExtractor } from "../types";

/**
 * Absolute backstop on source size. Deliberately set ABOVE both upload caps
 * (20 MB context, 25 MB attachment) so it never fires in normal operation.
 *
 * It has to be above them. Throwing here does not reject the file — the
 * factory catches and falls through to `LocalTextExtractor`, which hands the
 * model the full raw markup. So a ceiling *below* the upload cap would convert
 * "expensive parse" into "every large HTML file silently reverts to the
 * raw-markup behaviour this extractor exists to prevent", with no error and no
 * signal. This value only guards against a future upload-cap raise that
 * forgets about parsing cost.
 */
export const MAX_HTML_EXTRACTION_BYTES = 32 * 1024 * 1024; // 32 MB

export class LocalHtmlExtractor implements IDocumentExtractor {
	name = "local-html";
	supportedMimeTypes = ["text/html"];

	async extract(
		buffer: Buffer,
		filename: string,
		_options?: Record<string, unknown>,
	): Promise<ExtractionResult> {
		const startTime = Date.now();
		logger.info(`[LocalHtmlExtractor] Extracting text from ${filename}`);

		if (buffer.byteLength > MAX_HTML_EXTRACTION_BYTES) {
			throw new Error(
				`HTML source too large to parse: ${buffer.byteLength} bytes exceeds ${MAX_HTML_EXTRACTION_BYTES}`,
			);
		}

		try {
			const text = convert(buffer.toString("utf-8"), {
				// The upload pipeline re-wraps downstream; hard wrapping here
				// would corrupt code blocks and tables.
				wordwrap: false,
				selectors: [
					// Non-content subtrees. `script` is the security-relevant
					// one: its body must never reach a prompt.
					{ selector: "script", format: "skip" },
					{ selector: "style", format: "skip" },
					{ selector: "noscript", format: "skip" },
					{ selector: "head", format: "skip" },
					// Links and images render as their text, not their URLs —
					// a page full of hrefs is mostly navigation chrome.
					{ selector: "a", options: { ignoreHref: true } },
					{ selector: "img", format: "skip" },
					// html-to-text does not format tables by default — without
					// this, cell and row boundaries vanish and adjacent cells
					// run together into unseparated text, which is worse model
					// input than the raw markup this extractor replaces.
					{ selector: "table", format: "dataTable" },
				],
			}).trim();

			const extractionTime = Date.now() - startTime;
			logger.info(
				`[LocalHtmlExtractor] Extracted ${text.length} characters in ${extractionTime}ms`,
			);

			return {
				text,
				extractorUsed: this.name,
				extractionTime,
				cost: 0, // Free
				pageCount: undefined,
				hasTables: false,
				hasImages: false,
				metadata: {
					encoding: "utf-8",
					sourceBytes: buffer.byteLength,
				},
			};
		} catch (error) {
			logger.error(
				`[LocalHtmlExtractor] Failed to extract text: ${error}`,
			);
			throw new Error(
				`HTML extraction failed: ${error instanceof Error ? error.message : "Unknown error"}`,
			);
		}
	}

	async isAvailable(): Promise<boolean> {
		return true; // Always available (local)
	}

	async estimateCost(_buffer: Buffer): Promise<number> {
		return 0; // Free
	}
}
