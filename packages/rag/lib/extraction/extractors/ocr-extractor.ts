/**
 * OCR-based extractor for images and scanned PDFs
 * Uses Unstructured.io for text extraction
 */

import { logger } from "@repo/logs";
import { UnstructuredOcrProvider } from "../../ocr";
import type { ExtractionResult, IDocumentExtractor } from "../types";

export class OcrExtractor implements IDocumentExtractor {
	name = "ocr-unstructured";
	supportedMimeTypes = [
		"image/jpeg",
		"image/jpg",
		"image/png",
		"image/gif",
		"image/webp",
		"image/bmp",
		"image/tiff",
	];

	private ocrProvider: UnstructuredOcrProvider | null = null;

	constructor() {
		// Initialize OCR provider if API key is available
		const apiKey = process.env.UNSTRUCTURED_API_KEY;
		if (apiKey) {
			this.ocrProvider = new UnstructuredOcrProvider({ apiKey });
			logger.info(
				"[OcrExtractor] Initialized with Unstructured.io provider",
			);
		}
		// No key: stay silent at construction (extractors are instantiated at
		// import time, so a warn here spams every build worker). extract()
		// throws an actionable error when OCR is actually attempted.
	}

	async extract(
		buffer: Buffer,
		filename: string,
		_options?: Record<string, unknown>,
	): Promise<ExtractionResult> {
		const startTime = Date.now();
		logger.info(`[OcrExtractor] Extracting text from ${filename}`);

		if (!this.ocrProvider) {
			throw new Error(
				"OCR provider not initialized. Please set UNSTRUCTURED_API_KEY environment variable.",
			);
		}

		try {
			// Detect MIME type from filename extension
			const mimeType = this.detectMimeType(filename);

			// Use OCR provider to extract text
			const ocrResult = await this.ocrProvider.extractText(
				buffer,
				filename,
				mimeType,
			);

			const extractionTime = Date.now() - startTime;
			logger.info(
				`[OcrExtractor] Extracted ${ocrResult.text.length} characters in ${extractionTime}ms`,
			);

			return {
				text: ocrResult.text,
				extractorUsed: this.name,
				extractionTime,
				cost: ocrResult.cost,
				pageCount: ocrResult.pageCount,
				hasTables: false, // OCR doesn't detect table structure
				hasImages: true, // Source is an image
				metadata: {
					...ocrResult.metadata,
					confidence: ocrResult.confidence,
				},
			};
		} catch (error) {
			logger.error(`[OcrExtractor] Failed to extract text: ${error}`);
			throw new Error(
				`OCR extraction failed: ${error instanceof Error ? error.message : "Unknown error"}`,
			);
		}
	}

	async isAvailable(): Promise<boolean> {
		return this.ocrProvider !== null;
	}

	async estimateCost(_buffer: Buffer): Promise<number> {
		if (!this.ocrProvider) {
			return 0;
		}
		// Estimate 1 page per image, $0.01 per page
		return 0.01;
	}

	/**
	 * Detect MIME type from filename extension
	 */
	private detectMimeType(filename: string): string {
		const ext = filename.toLowerCase().split(".").pop();
		const mimeTypeMap: Record<string, string> = {
			jpg: "image/jpeg",
			jpeg: "image/jpeg",
			png: "image/png",
			gif: "image/gif",
			webp: "image/webp",
			bmp: "image/bmp",
			tiff: "image/tiff",
			tif: "image/tiff",
		};

		return mimeTypeMap[ext || ""] || "application/octet-stream";
	}
}
