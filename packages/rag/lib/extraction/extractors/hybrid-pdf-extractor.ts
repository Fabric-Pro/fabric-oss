/**
 * Hybrid PDF extractor that detects text-based vs scanned PDFs
 * Uses pdf-parse for text-based PDFs, OCR for scanned PDFs
 */

import { logger } from "@repo/logs";
import pdfParse from "pdf-parse";
import { UnstructuredOcrProvider } from "../../ocr";
import type { ExtractionResult, IDocumentExtractor } from "../types";

export class HybridPdfExtractor implements IDocumentExtractor {
	name = "hybrid-pdf";
	supportedMimeTypes = ["application/pdf"];

	private ocrProvider: UnstructuredOcrProvider | null = null;

	constructor() {
		// Initialize OCR provider if API key is available
		const apiKey = process.env.UNSTRUCTURED_API_KEY;
		if (apiKey) {
			this.ocrProvider = new UnstructuredOcrProvider({ apiKey });
			logger.info(
				"[HybridPdfExtractor] Initialized with OCR support for scanned PDFs",
			);
		}
		// No key: stay silent at construction (extractors are instantiated at
		// import time, so a warn here spams every build worker). extract()
		// throws an actionable error the moment a scanned PDF actually needs OCR.
	}

	async extract(
		buffer: Buffer,
		filename: string,
		_options?: Record<string, unknown>,
	): Promise<ExtractionResult> {
		const startTime = Date.now();
		logger.info(`[HybridPdfExtractor] Extracting text from ${filename}`);

		try {
			// First, try to extract text using pdf-parse
			// Empty options object is required: pdf-parse v1.1.4 mutates
			// the options object in-place to populate its `version` /
			// `pagerender` defaults; calling without an argument leaves
			// the bundled pdf.js on a strict-XRef code path that rejects
			// PDFs other tools accept (mirrors the same fix in
			// `local-pdf.ts`).
			const pdfData = await pdfParse(buffer, {});

			// Check if PDF contains meaningful text
			const isTextBased = this.isTextBasedPdf(
				pdfData.text,
				pdfData.numpages,
			);

			if (isTextBased) {
				// Text-based PDF - use pdf-parse result
				const extractionTime = Date.now() - startTime;
				logger.info(
					`[HybridPdfExtractor] Text-based PDF detected, extracted ${pdfData.text.length} characters in ${extractionTime}ms`,
				);

				return {
					text: pdfData.text,
					extractorUsed: "local-pdf",
					extractionTime,
					cost: 0, // Free
					pageCount: pdfData.numpages,
					hasTables: false,
					hasImages: false,
					metadata: {
						info: pdfData.info,
						version: pdfData.version,
						detectionMethod: "text-based",
					},
				};
			}

			// Scanned PDF - use OCR
			logger.info(
				`[HybridPdfExtractor] Scanned PDF detected (${pdfData.text.length} chars extracted, likely insufficient), using OCR`,
			);

			if (!this.ocrProvider) {
				throw new Error(
					"Scanned PDF detected but OCR provider not initialized. Please set UNSTRUCTURED_API_KEY environment variable.",
				);
			}

			const ocrResult = await this.ocrProvider.extractText(
				buffer,
				filename,
				"application/pdf",
			);

			const extractionTime = Date.now() - startTime;
			logger.info(
				`[HybridPdfExtractor] OCR extraction completed, extracted ${ocrResult.text.length} characters in ${extractionTime}ms`,
			);

			return {
				text: ocrResult.text,
				extractorUsed: "ocr-unstructured",
				extractionTime,
				cost: ocrResult.cost,
				pageCount: pdfData.numpages || ocrResult.pageCount,
				hasTables: false,
				hasImages: true,
				metadata: {
					...ocrResult.metadata,
					detectionMethod: "scanned",
					confidence: ocrResult.confidence,
				},
			};
		} catch (error) {
			logger.error(
				`[HybridPdfExtractor] Failed to extract PDF: ${error}`,
			);
			throw new Error(
				`PDF extraction failed: ${error instanceof Error ? error.message : "Unknown error"}`,
			);
		}
	}

	/**
	 * Detect if a PDF is text-based or scanned
	 * Heuristic: If text length is less than 50 characters per page, it's likely scanned
	 */
	private isTextBasedPdf(text: string, pageCount: number): boolean {
		if (!text || text.trim().length === 0) {
			return false;
		}

		// Calculate average characters per page
		const avgCharsPerPage = text.length / Math.max(pageCount, 1);

		// Threshold: If less than 50 characters per page, likely scanned
		// This is a heuristic and may need tuning
		const threshold = 50;

		logger.info(
			`[HybridPdfExtractor] PDF analysis: ${text.length} chars, ${pageCount} pages, ${avgCharsPerPage.toFixed(0)} chars/page (threshold: ${threshold})`,
		);

		return avgCharsPerPage >= threshold;
	}

	async isAvailable(): Promise<boolean> {
		return true; // Always available (pdf-parse is always available, OCR is optional)
	}

	async estimateCost(buffer: Buffer): Promise<number> {
		// Try to detect if it's text-based or scanned
		try {
			// Empty options object is required: pdf-parse v1.1.4 mutates
			// the options object in-place to populate its `version` /
			// `pagerender` defaults; calling without an argument leaves
			// the bundled pdf.js on a strict-XRef code path that rejects
			// PDFs other tools accept (mirrors the same fix in
			// `local-pdf.ts`).
			const pdfData = await pdfParse(buffer, {});
			const isTextBased = this.isTextBasedPdf(
				pdfData.text,
				pdfData.numpages,
			);
			if (isTextBased) {
				return 0; // Free (pdf-parse)
			}
			// Scanned PDF - estimate OCR cost
			const estimatedPages =
				pdfData.numpages || Math.ceil(buffer.length / (50 * 1024));
			return estimatedPages * 0.01; // $0.01 per page for Unstructured.io
		} catch {
			// If parsing fails, assume scanned
			const estimatedPages = Math.ceil(buffer.length / (50 * 1024));
			return estimatedPages * 0.01;
		}
	}
}
