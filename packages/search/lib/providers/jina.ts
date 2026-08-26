/**
 * Jina AI Search Provider
 * https://jina.ai - Web search and content reader API
 *
 * Uses:
 * - https://s.jina.ai/{query} - Web search
 * - https://r.jina.ai/{url} - URL scraping (Reader)
 */

import { logger } from "@repo/logs";
import type {
	SearchOptions,
	SearchProviderMetadata,
	SearchResponse,
	SearchResult,
	TestConnectionResult,
} from "../types";
import { BaseSearchProvider } from "./base";

const JINA_SEARCH_URL = "https://s.jina.ai";
const JINA_READER_URL = "https://r.jina.ai";
const DEFAULT_TIMEOUT = 30000;

/**
 * Jina AI search provider implementation
 */
export class JinaSearchProvider extends BaseSearchProvider {
	readonly metadata: SearchProviderMetadata = {
		name: "jina",
		displayName: "Jina AI",
		description:
			"Web search and content reader API. Powers Fabric AI search and scraping tools.",
		keyPrefix: "JINA_API_KEY",
		docsUrl: "https://jina.ai/reader",
		icon: "globe",
		supportedCategories: ["general", "news"],
		supportsContentRetrieval: true,
		supportsImageSearch: false,
		rateLimit: 100, // requests per minute (free tier)
		costPerSearch: 0.001,
	};

	/**
	 * Perform a search using Jina AI Search
	 */
	async search(
		query: string,
		options: SearchOptions = {},
	): Promise<SearchResponse> {
		const startTime = Date.now();

		if (!this.apiKey) {
			throw new Error("Jina API key is required");
		}

		const { maxResults = 10 } = options;

		logger.info(`[JinaSearchProvider] Searching for: "${query}"`, {
			maxResults,
		});

		try {
			const url = `${JINA_SEARCH_URL}/${encodeURIComponent(query)}`;

			const controller = new AbortController();
			const timeoutId = setTimeout(
				() => controller.abort(),
				DEFAULT_TIMEOUT,
			);

			const response = await fetch(url, {
				method: "GET",
				headers: {
					Authorization: `Bearer ${this.apiKey}`,
					Accept: "application/json",
					"X-Return-Format": "markdown",
				},
				signal: controller.signal,
			});

			clearTimeout(timeoutId);

			if (!response.ok) {
				const errorBody = await response.text();
				throw new Error(
					`Jina search failed (${response.status}): ${errorBody}`,
				);
			}

			// Jina returns markdown text, we need to parse it into results
			const content = await response.text();
			const searchTime = Date.now() - startTime;

			// Parse the markdown content into search results
			// Jina returns results in a specific markdown format
			const results = this.parseSearchResults(content, maxResults);

			logger.info("[JinaSearchProvider] Search completed", {
				resultCount: results.length,
				searchTime,
			});

			return {
				results,
				providerUsed: this.metadata.name,
				searchTime,
				totalResults: results.length,
				hasMore: false,
			};
		} catch (error) {
			const errorMessage =
				error instanceof Error ? error.message : String(error);
			logger.error(`[JinaSearchProvider] Search failed: ${errorMessage}`);
			throw error;
		}
	}

	/**
	 * Parse Jina search results from markdown format
	 */
	private parseSearchResults(
		content: string,
		maxResults: number,
	): SearchResult[] {
		const results: SearchResult[] = [];

		// Jina search returns results in markdown with URLs and titles
		// Try to extract structured data from the content
		const urlRegex = /https?:\/\/[^\s\])"'<>]+/g;
		const urls = content.match(urlRegex) || [];

		// Get unique URLs
		const seenUrls = new Set<string>();
		const uniqueUrls = urls.filter((url) => {
			if (seenUrls.has(url)) {
				return false;
			}
			seenUrls.add(url);
			return true;
		});

		// Create results from URLs found in the content
		for (let i = 0; i < Math.min(uniqueUrls.length, maxResults); i++) {
			const url = uniqueUrls[i];
			results.push({
				title: this.extractTitleFromUrl(url),
				url,
				snippet: content.slice(0, 500), // Use beginning of content as snippet
				score: 1 - i * 0.1, // Decreasing score for ordering
				source: "jina",
			});
		}

		// If no URLs found, return the content as a single result
		if (results.length === 0 && content.trim()) {
			results.push({
				title: "Search Results",
				url: "",
				snippet: content.slice(0, 1000),
				content: content,
				score: 1,
				source: "jina",
			});
		}

		return results;
	}

	/**
	 * Extract a readable title from a URL
	 */
	private extractTitleFromUrl(url: string): string {
		try {
			const urlObj = new URL(url);
			const path = urlObj.pathname
				.replace(/\//g, " ")
				.replace(/-/g, " ")
				.trim();
			return path || urlObj.hostname;
		} catch {
			return url;
		}
	}

	/**
	 * Retrieve full content from a URL using Jina Reader
	 */
	override async retrieveContent(url: string): Promise<SearchResult | null> {
		if (!this.apiKey) {
			throw new Error("Jina API key is required");
		}

		logger.info(`[JinaSearchProvider] Retrieving content from: ${url}`);

		try {
			const readerUrl = `${JINA_READER_URL}/${url}`;

			const controller = new AbortController();
			const timeoutId = setTimeout(
				() => controller.abort(),
				DEFAULT_TIMEOUT,
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
				logger.error(
					`[JinaSearchProvider] Content retrieval failed: ${errorBody}`,
				);
				return null;
			}

			const content = await response.text();

			return {
				title: this.extractTitleFromUrl(url),
				url,
				snippet: content.slice(0, 500),
				content,
				score: 1,
				source: "jina",
			};
		} catch (error) {
			const errorMessage =
				error instanceof Error ? error.message : String(error);
			logger.error(
				`[JinaSearchProvider] Content retrieval failed: ${errorMessage}`,
			);
			return null;
		}
	}

	/**
	 * Check if the provider is available (has API key)
	 */
	override async isAvailable(): Promise<boolean> {
		return !!this.apiKey;
	}

	/**
	 * Test connection to Jina AI
	 */
	override async testConnection(): Promise<TestConnectionResult> {
		if (!this.apiKey) {
			return {
				success: false,
				error: "API key is required",
			};
		}

		const startTime = Date.now();

		try {
			// Test using the Reader API with a simple, fast-loading URL
			const testUrl = `${JINA_READER_URL}/https://example.com`;

			const response = await fetch(testUrl, {
				method: "GET",
				headers: {
					Authorization: `Bearer ${this.apiKey}`,
					Accept: "text/plain",
				},
			});

			const responseTime = Date.now() - startTime;

			if (response.ok) {
				return {
					success: true,
					responseTime,
					info: {
						provider: "Jina AI",
						status: "Connected",
					},
				};
			}

			const errorBody = await response.text();

			// Check for authentication errors specifically
			if (response.status === 401 || response.status === 403) {
				return {
					success: false,
					error: "Invalid API key. Please check your Jina AI API key.",
					responseTime,
				};
			}

			return {
				success: false,
				error: `Connection failed (${response.status}): ${errorBody}`,
				responseTime,
			};
		} catch (error) {
			const responseTime = Date.now() - startTime;
			const errorMessage =
				error instanceof Error ? error.message : String(error);

			// Handle abort/timeout errors more gracefully
			if (
				errorMessage.toLowerCase().includes("abort") ||
				errorMessage.toLowerCase().includes("timeout")
			) {
				return {
					success: false,
					error: "Connection timed out. Please try again.",
					responseTime,
				};
			}

			return {
				success: false,
				error: errorMessage,
				responseTime,
			};
		}
	}
}
