/**
 * LlamaParse Extractor
 * Uses LlamaIndex's LlamaParse service for high-quality PDF extraction
 * Supports complex PDFs with tables, forms, and multi-column layouts
 */

import { logger } from "@repo/logs";
import type { ExtractionResult, IDocumentExtractor, TableData } from "../types";

interface ParseOptions {
	file: Buffer;
	filename: string;
	resultType?: "text" | "markdown";
	language?: string;
	targetPages?: string;
	invalidateCache?: boolean;
}

interface ParseResult {
	text?: string;
	markdown?: string;
	pages?: Array<{ page: number; text: string }>;
	language?: string;
}

/**
 * LlamaParse Extractor
 * Best for: Complex PDFs with tables, forms, multi-column layouts
 * Cost: $0.003 per page (first 1,000 pages free daily)
 */
export class LlamaParseExtractor implements IDocumentExtractor {
	name = "llamaparse";
	supportedMimeTypes = [
		"application/pdf",
		"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
		"application/vnd.openxmlformats-officedocument.presentationml.presentation",
		"image/png",
		"image/jpeg",
	];

	private apiKey: string;
	private endpoint: string;

	constructor(apiKey: string, options?: { endpoint?: string }) {
		this.apiKey = apiKey;
		this.endpoint =
			options?.endpoint || "https://api.cloud.llamaindex.ai/api/parsing";
	}

	async extract(
		buffer: Buffer,
		filename: string,
		options?: Record<string, unknown>,
	): Promise<ExtractionResult> {
		const startTime = Date.now();

		try {
			logger.info(
				`[LlamaParseExtractor] Extracting text from ${filename}`,
			);

			// Call LlamaParse API
			const result = await this.callLlamaParseAPI({
				file: buffer,
				filename,
				resultType:
					(options?.resultType as "text" | "markdown") || "markdown",
				language: (options?.language as string) || "en",
				targetPages: options?.targetPages as string | undefined,
				invalidateCache: (options?.invalidateCache as boolean) || false,
			});

			// Extract tables from markdown if present
			const tables = this.extractTablesFromMarkdown(
				result.markdown || result.text || "",
			);

			const extractionTime = Date.now() - startTime;
			const text = result.text || result.markdown || "";

			logger.info(
				`[LlamaParseExtractor] Successfully extracted ${text.length} characters in ${extractionTime}ms`,
			);

			return {
				text,
				extractorUsed: this.name,
				extractionTime,
				pageCount: result.pages?.length,
				confidence: 0.95, // LlamaParse has high confidence
				hasTables: tables.length > 0,
				language: result.language,
				cost: this.calculateCost(buffer),
				tables: tables.length > 0 ? tables : undefined,
			};
		} catch (error) {
			logger.error(`[LlamaParseExtractor] Extraction failed: ${error}`);
			throw new Error(
				`LlamaParse extraction failed: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	/**
	 * Call LlamaParse API
	 */
	private async callLlamaParseAPI(
		options: ParseOptions,
	): Promise<ParseResult> {
		try {
			// Create form data
			const formData = new FormData();
			const uint8Array = new Uint8Array(options.file);
			const blob = new Blob([uint8Array], {
				type: "application/octet-stream",
			});
			formData.append("file", blob, options.filename);
			formData.append("result_type", options.resultType || "markdown");
			formData.append("language", options.language || "en");

			if (options.targetPages) {
				formData.append("target_pages", options.targetPages);
			}
			if (options.invalidateCache) {
				formData.append("invalidate_cache", "true");
			}

			// Make API request
			const response = await fetch(`${this.endpoint}/upload`, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${this.apiKey}`,
				},
				body: formData,
			});

			if (!response.ok) {
				const errorText = await response.text();
				throw new Error(
					`LlamaParse API error (${response.status}): ${errorText}`,
				);
			}

			const data = await response.json();

			// Poll for result
			const jobId = data.id;
			const result = await this.pollForResult(jobId);

			return result;
		} catch (error) {
			logger.error(`[LlamaParseExtractor] API call failed: ${error}`);
			throw error;
		}
	}

	/**
	 * Poll for parsing result
	 */
	private async pollForResult(jobId: string): Promise<ParseResult> {
		const maxAttempts = 60; // 5 minutes max (5 second intervals)
		const pollInterval = 5000; // 5 seconds

		for (let attempt = 0; attempt < maxAttempts; attempt++) {
			try {
				const response = await fetch(`${this.endpoint}/job/${jobId}`, {
					headers: {
						Authorization: `Bearer ${this.apiKey}`,
					},
				});

				if (!response.ok) {
					throw new Error(
						`Failed to get job status: ${response.status}`,
					);
				}

				const data = await response.json();

				if (data.status === "SUCCESS") {
					return {
						text: data.text,
						markdown: data.markdown,
						pages: data.pages,
						language: data.language,
					};
				}

				if (data.status === "ERROR") {
					throw new Error(`LlamaParse job failed: ${data.error}`);
				}

				// Wait before next poll
				await new Promise((resolve) =>
					setTimeout(resolve, pollInterval),
				);
			} catch (error) {
				logger.error(`[LlamaParseExtractor] Polling error: ${error}`);
				throw error;
			}
		}

		throw new Error("LlamaParse job timeout");
	}

	/**
	 * Extract tables from markdown
	 */
	private extractTablesFromMarkdown(markdown: string): TableData[] {
		const tables: TableData[] = [];
		const tableRegex = /\|(.+)\|/g;
		const matches = markdown.match(tableRegex);

		if (!matches || matches.length === 0) {
			return tables;
		}

		// Parse markdown tables (simplified)
		const tableRows = matches.map((row) =>
			row
				.split("|")
				.filter((cell) => cell.trim())
				.map((cell) => cell.trim()),
		);

		if (tableRows.length > 0) {
			tables.push({
				headers: tableRows[0],
				rows: tableRows.slice(1),
			});
		}

		return tables;
	}

	/**
	 * Calculate estimated cost
	 * $0.003 per page, assume 1 page per 50KB
	 */
	private calculateCost(buffer: Buffer): number {
		const estimatedPages = Math.ceil(buffer.length / (50 * 1024));
		return estimatedPages * 0.003;
	}

	/**
	 * Check if LlamaParse is available
	 */
	async isAvailable(): Promise<boolean> {
		if (!this.apiKey) {
			return false;
		}

		try {
			// Test API connectivity by checking credits
			const response = await fetch(`${this.endpoint}/credits`, {
				headers: {
					Authorization: `Bearer ${this.apiKey}`,
				},
			});
			return response.ok;
		} catch {
			return false;
		}
	}

	/**
	 * Estimate cost for extraction
	 */
	async estimateCost(buffer: Buffer): Promise<number> {
		return this.calculateCost(buffer);
	}
}
