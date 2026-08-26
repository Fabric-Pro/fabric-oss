/**
 * Local DOCX extractor using mammoth
 * Free, good quality text extraction from Word documents
 */

import { logger } from "@repo/logs";
import mammoth from "mammoth";
import type { ExtractionResult, IDocumentExtractor } from "../types";

export class LocalDocxExtractor implements IDocumentExtractor {
	name = "local-docx";
	supportedMimeTypes = [
		"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
		"application/msword",
	];

	async extract(
		buffer: Buffer,
		filename: string,
		_options?: Record<string, unknown>,
	): Promise<ExtractionResult> {
		const startTime = Date.now();
		logger.info(`[LocalDocxExtractor] Extracting text from ${filename}`);

		try {
			const result = await mammoth.extractRawText({ buffer });

			const extractionTime = Date.now() - startTime;
			logger.info(
				`[LocalDocxExtractor] Extracted ${result.value.length} characters in ${extractionTime}ms`,
			);

			return {
				text: result.value,
				extractorUsed: this.name,
				extractionTime,
				cost: 0, // Free
				pageCount: undefined, // mammoth doesn't provide page count
				hasTables: false, // mammoth doesn't detect tables
				hasImages: false, // mammoth doesn't detect images
				metadata: {
					messages: result.messages,
				},
			};
		} catch (error) {
			logger.error(
				`[LocalDocxExtractor] Failed to extract DOCX: ${error}`,
			);
			throw new Error(
				`DOCX extraction failed: ${error instanceof Error ? error.message : "Unknown error"}`,
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
