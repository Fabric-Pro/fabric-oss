/**
 * Local PDF extractor using pdf-parse
 * Free, fast, but basic text extraction
 */

import { logger } from "@repo/logs";
import pdfParse from "pdf-parse";
import type { ExtractionResult, IDocumentExtractor } from "../types";

export class LocalPdfExtractor implements IDocumentExtractor {
	name = "local-pdf";
	supportedMimeTypes = ["application/pdf"];

	async extract(
		buffer: Buffer,
		filename: string,
		_options?: Record<string, unknown>,
	): Promise<ExtractionResult> {
		const startTime = Date.now();
		logger.info(`[LocalPdfExtractor] Extracting text from ${filename}`);

		try {
			// `pdfParse(buffer)` with no second argument trips a "bad XRef
			// entry" on perfectly valid PDFs because pdf-parse v1.1.4
			// mutates the options object to populate its `version` /
			// `pagerender` defaults — when no object is passed, those
			// defaults never apply and the bundled pdf.js takes a
			// strict-XRef code path that rejects PDFs other tools accept
			// (jsPDF output, exported reports, etc.). Passing an empty
			// options object is enough to enable the standard parsing
			// path. See the pdf-parse README and the regression that
			// motivated this fix.
			const data = await pdfParse(buffer, {});

			const extractionTime = Date.now() - startTime;
			logger.info(
				`[LocalPdfExtractor] Extracted ${data.text.length} characters in ${extractionTime}ms`,
			);

			return {
				text: data.text,
				extractorUsed: this.name,
				extractionTime,
				cost: 0, // Free
				pageCount: data.numpages,
				hasTables: false, // pdf-parse doesn't detect tables
				hasImages: false, // pdf-parse doesn't detect images
				metadata: {
					info: data.info,
					version: data.version,
				},
			};
		} catch (error) {
			logger.error(`[LocalPdfExtractor] Failed to extract PDF: ${error}`);
			throw new Error(
				`PDF extraction failed: ${error instanceof Error ? error.message : "Unknown error"}`,
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
