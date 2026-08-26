/**
 * Browser-based content extractor for web pages
 *
 * Extracts content from web pages that require browser rendering,
 * including pages with JavaScript, authentication, or complex layouts.
 *
 * Integrates with:
 * - Temporal browser automation workflows
 * - RAG pipeline for document processing
 * - Multi-tenancy (userId + organizationId scoping)
 */

import { logger } from "@repo/logs";
import type { ExtractionResult, IDocumentExtractor } from "../types";

/**
 * Options for browser-based extraction
 */
export interface BrowserExtractionOptions {
	/** User ID for multi-tenancy */
	userId?: string;
	/** Organization ID for multi-tenancy */
	organizationId?: string;
	/** URL to extract content from (used when buffer contains URL string) */
	url?: string;
	/** CSS selectors for content extraction */
	selectors?: {
		/** Main content selector (default: body) */
		content?: string;
		/** Title selector (default: h1, title) */
		title?: string;
		/** Selectors to exclude (default: nav, footer, script, style) */
		exclude?: string[];
	};
	/** Wait for specific element before extraction */
	waitForSelector?: string;
	/** Authentication configuration */
	auth?: {
		/** MCP config ID for OAuth */
		mcpConfigId?: string;
		/** Basic auth credentials */
		basicAuth?: { username: string; password: string };
	};
	/** Whether to take a screenshot */
	screenshot?: boolean;
	/** Timeout in milliseconds (default: 60000) */
	timeout?: number;
}

/**
 * Browser-based document extractor
 *
 * Uses Playwright via Temporal workflows to extract content from web pages.
 * Suitable for:
 * - JavaScript-rendered pages (SPAs)
 * - Authenticated content (Confluence Server, internal wikis)
 * - Complex layouts requiring browser rendering
 * - Pages with lazy-loaded content
 */
export class BrowserExtractor implements IDocumentExtractor {
	name = "browser";
	supportedMimeTypes = [
		"text/html",
		"application/xhtml+xml",
		"text/uri-list", // URLs as text
	];

	/**
	 * Check if browser extraction is available
	 * Requires Temporal worker with browser automation activities
	 */
	async isAvailable(): Promise<boolean> {
		// Browser extractor is always "available" as a fallback
		// Actual availability depends on Temporal worker status
		return true;
	}

	/**
	 * Extract content from a web page
	 *
	 * @param buffer - URL as buffer or HTML content
	 * @param filename - URL or filename hint
	 * @param options - Extraction options
	 */
	async extract(
		buffer: Buffer,
		_filename: string,
		options?: Record<string, unknown>,
	): Promise<ExtractionResult> {
		const startTime = Date.now();
		const browserOptions = options as BrowserExtractionOptions | undefined;

		// Determine URL from buffer or options
		const urlString = buffer.toString("utf-8").trim();
		const url =
			browserOptions?.url ||
			(this.isValidUrl(urlString) ? urlString : null);

		if (!url) {
			throw new Error("BrowserExtractor requires a valid URL");
		}

		logger.info(`[BrowserExtractor] Extracting content from: ${url}`);

		try {
			// Import Temporal client dynamically to avoid circular deps
			const { extractWebContent } = await import(
				"./browser-extractor-client"
			);

			const result = await extractWebContent({
				url,
				userId: browserOptions?.userId,
				organizationId: browserOptions?.organizationId,
				selectors: browserOptions?.selectors,
				waitForSelector: browserOptions?.waitForSelector,
				auth: browserOptions?.auth,
				screenshot: browserOptions?.screenshot,
				timeout: browserOptions?.timeout,
			});

			const extractionTime = Date.now() - startTime;

			logger.info(
				`[BrowserExtractor] Extracted ${result.text.length} chars from ${url} in ${extractionTime}ms`,
			);

			return {
				text: result.text,
				extractorUsed: this.name,
				extractionTime,
				cost: 0, // Browser extraction is free (local Playwright)
				metadata: {
					url,
					title: result.title,
					screenshotUrl: result.screenshotUrl,
					extractedAt: new Date().toISOString(),
				},
			};
		} catch (error) {
			logger.error(
				`[BrowserExtractor] Failed to extract from ${url}:`,
				error,
			);
			throw error;
		}
	}

	/**
	 * Estimate extraction cost (always 0 for browser extraction)
	 */
	async estimateCost(_buffer: Buffer): Promise<number> {
		return 0;
	}

	/**
	 * Check if a string is a valid URL
	 */
	private isValidUrl(str: string): boolean {
		try {
			new URL(str);
			return true;
		} catch {
			return false;
		}
	}
}
