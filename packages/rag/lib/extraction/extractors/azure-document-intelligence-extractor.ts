/**
 * Azure Document Intelligence Extractor
 * Uses Microsoft Azure's Document Intelligence service for document analysis
 * Supports OCR, layout analysis, tables, and forms
 */

import {
	AzureKeyCredential,
	DocumentAnalysisClient,
} from "@azure/ai-form-recognizer";
import { logger } from "@repo/logs";
import type { ExtractionResult, IDocumentExtractor, TableData } from "../types";

/**
 * Azure Document Intelligence Extractor
 * Best for: Microsoft ecosystem, high-volume processing, enterprise workflows
 * Cost: $0.001 per page (Read API) to $0.01 per page (Layout API)
 */
export class AzureDocumentIntelligenceExtractor implements IDocumentExtractor {
	name = "azure-document-intelligence";
	supportedMimeTypes = [
		"application/pdf",
		"image/jpeg",
		"image/png",
		"image/tiff",
		"image/bmp",
		"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
		"application/vnd.openxmlformats-officedocument.presentationml.presentation",
		"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
	];

	private client: DocumentAnalysisClient;
	private endpoint: string;
	private apiKey: string;

	constructor(apiKey: string, endpoint: string) {
		this.apiKey = apiKey;
		this.endpoint = endpoint;
		this.client = new DocumentAnalysisClient(
			endpoint,
			new AzureKeyCredential(apiKey),
		);
	}

	async extract(
		buffer: Buffer,
		filename: string,
		options?: Record<string, unknown>,
	): Promise<ExtractionResult> {
		const startTime = Date.now();

		try {
			logger.info(
				`[AzureDocumentIntelligenceExtractor] Extracting text from ${filename}`,
			);

			// Use "prebuilt-layout" model for comprehensive extraction
			// Other options: "prebuilt-read" (faster, cheaper), "prebuilt-document" (more features)
			const modelId = (options?.modelId as string) || "prebuilt-layout";

			// Convert Buffer to Uint8Array for Azure SDK
			const uint8Array = new Uint8Array(buffer);

			// Analyze document
			const poller = await this.client.beginAnalyzeDocument(
				modelId,
				uint8Array,
			);
			const result = await poller.pollUntilDone();

			// Extract text content
			let text = "";
			if (result.content) {
				text = result.content;
			}

			// Extract tables
			const tables: TableData[] = [];
			if (result.tables) {
				for (const table of result.tables) {
					const tableData: TableData = {
						rows: [],
						headers: [],
					};

					// Group cells by row
					const rowMap = new Map<number, string[]>();
					for (const cell of table.cells) {
						if (!rowMap.has(cell.rowIndex)) {
							rowMap.set(cell.rowIndex, []);
						}
						const row = rowMap.get(cell.rowIndex);
						if (row) {
							row[cell.columnIndex] = cell.content;
						}
					}

					// Convert to array
					const rows = Array.from(rowMap.values());
					if (rows.length > 0) {
						tableData.headers = rows[0];
						tableData.rows = rows.slice(1);
						tables.push(tableData);
					}
				}
			}

			const extractionTime = Date.now() - startTime;
			const pageCount = result.pages?.length || 0;

			logger.info(
				`[AzureDocumentIntelligenceExtractor] Successfully extracted ${text.length} characters in ${extractionTime}ms`,
			);

			return {
				text,
				extractorUsed: this.name,
				extractionTime,
				pageCount,
				confidence: this.calculateAverageConfidence(result),
				hasTables: tables.length > 0,
				hasImages: false, // Azure doesn't extract images directly
				cost: this.calculateCost(pageCount, modelId),
				tables: tables.length > 0 ? tables : undefined,
			};
		} catch (error) {
			logger.error(
				`[AzureDocumentIntelligenceExtractor] Extraction failed: ${error}`,
			);
			throw new Error(
				`Azure Document Intelligence extraction failed: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	/**
	 * Calculate average confidence from Azure result
	 */
	private calculateAverageConfidence(result: any): number {
		if (!result.pages || result.pages.length === 0) {
			return 0.9; // Default high confidence
		}

		let totalConfidence = 0;
		let count = 0;

		for (const page of result.pages) {
			if (page.words) {
				for (const word of page.words) {
					if (word.confidence !== undefined) {
						totalConfidence += word.confidence;
						count++;
					}
				}
			}
		}

		return count > 0 ? totalConfidence / count : 0.9;
	}

	/**
	 * Calculate cost based on model and page count
	 */
	private calculateCost(pageCount: number, modelId: string): number {
		// Pricing varies by model
		const costPerPage: Record<string, number> = {
			"prebuilt-read": 0.001, // $0.001 per page
			"prebuilt-layout": 0.01, // $0.01 per page
			"prebuilt-document": 0.01, // $0.01 per page
		};

		const cost = costPerPage[modelId] || 0.01;
		return pageCount * cost;
	}

	/**
	 * Check if Azure Document Intelligence is available
	 */
	async isAvailable(): Promise<boolean> {
		if (!this.apiKey || !this.endpoint) {
			return false;
		}

		try {
			// Test API connectivity by analyzing a minimal document
			// We can't easily test without a document, so we just check if credentials are set
			return true;
		} catch {
			return false;
		}
	}

	/**
	 * Estimate cost for extraction
	 */
	async estimateCost(buffer: Buffer): Promise<number> {
		// Rough estimate: assume 1 page per 50KB
		const estimatedPages = Math.ceil(buffer.length / (50 * 1024));
		// Use layout model pricing as default
		return this.calculateCost(estimatedPages, "prebuilt-layout");
	}
}
