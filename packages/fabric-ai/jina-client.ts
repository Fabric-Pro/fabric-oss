/**
 * Jina AI Client
 *
 * Direct client for Jina AI services (search and scrape).
 * Used when Fabric AI server doesn't have Jina credentials configured.
 *
 * Services:
 * - https://s.jina.ai/{query} - Web search
 * - https://r.jina.ai/{url} - URL scraping (Reader)
 */

import { logger } from "@repo/logs";

const JINA_SEARCH_URL = "https://s.jina.ai";
const JINA_READER_URL = "https://r.jina.ai";
const DEFAULT_TIMEOUT = 30000; // 30 seconds

export interface JinaClientConfig {
	apiKey: string;
	timeout?: number;
}

export interface JinaSearchResult {
	content: string;
	success: boolean;
	error?: string;
}

export interface JinaScrapeResult {
	content: string;
	success: boolean;
	error?: string;
}

/**
 * Jina AI Client for direct API access
 */
export class JinaClient {
	private apiKey: string;
	private timeout: number;

	constructor(config: JinaClientConfig) {
		this.apiKey = config.apiKey;
		this.timeout = config.timeout ?? DEFAULT_TIMEOUT;
	}

	/**
	 * Search the web using Jina AI Search
	 *
	 * @param query - Search query
	 * @returns Search results as clean text
	 */
	async search(query: string): Promise<JinaSearchResult> {
		const url = `${JINA_SEARCH_URL}/${encodeURIComponent(query)}`;

		try {
			const controller = new AbortController();
			const timeoutId = setTimeout(
				() => controller.abort(),
				this.timeout,
			);

			const response = await fetch(url, {
				method: "GET",
				headers: {
					Authorization: `Bearer ${this.apiKey}`,
					Accept: "text/plain",
				},
				signal: controller.signal,
			});

			clearTimeout(timeoutId);

			if (!response.ok) {
				const errorBody = await response.text();
				logger.error(`[JinaClient] Search failed: ${response.status}`, {
					error: errorBody,
				});
				return {
					content: "",
					success: false,
					error: `Jina search failed (${response.status}): ${errorBody}`,
				};
			}

			const content = await response.text();
			return {
				content,
				success: true,
			};
		} catch (error) {
			const errorMessage =
				error instanceof Error ? error.message : String(error);
			logger.error(`[JinaClient] Search error: ${errorMessage}`);
			return {
				content: "",
				success: false,
				error: errorMessage,
			};
		}
	}

	/**
	 * Scrape a URL using Jina AI Reader
	 *
	 * @param url - URL to scrape
	 * @returns Scraped content as clean markdown
	 */
	async scrape(url: string): Promise<JinaScrapeResult> {
		const readerUrl = `${JINA_READER_URL}/${url}`;

		try {
			const controller = new AbortController();
			const timeoutId = setTimeout(
				() => controller.abort(),
				this.timeout,
			);

			const response = await fetch(readerUrl, {
				method: "GET",
				headers: {
					Authorization: `Bearer ${this.apiKey}`,
					Accept: "text/plain",
				},
				signal: controller.signal,
			});

			clearTimeout(timeoutId);

			if (!response.ok) {
				const errorBody = await response.text();
				logger.error(`[JinaClient] Scrape failed: ${response.status}`, {
					error: errorBody,
				});
				return {
					content: "",
					success: false,
					error: `Jina scrape failed (${response.status}): ${errorBody}`,
				};
			}

			const content = await response.text();
			return {
				content,
				success: true,
			};
		} catch (error) {
			const errorMessage =
				error instanceof Error ? error.message : String(error);
			logger.error(`[JinaClient] Scrape error: ${errorMessage}`);
			return {
				content: "",
				success: false,
				error: errorMessage,
			};
		}
	}
}

/**
 * Create a Jina AI client
 */
export function createJinaClient(config: JinaClientConfig): JinaClient {
	return new JinaClient(config);
}
