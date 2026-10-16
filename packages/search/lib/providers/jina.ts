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
import { fetchSearchEndpoint } from "./outbound";

const JINA_SEARCH_URL = "https://s.jina.ai";
const JINA_READER_URL = "https://r.jina.ai";
const DEFAULT_TIMEOUT = 30000;

/** One entry of the `data` array in a JSON s.jina.ai response. */
interface JinaSearchEntry {
	title?: unknown;
	url?: unknown;
	description?: unknown;
	content?: unknown;
	date?: unknown;
}

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

			const response = await fetchSearchEndpoint(url, {
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

			// With Accept: application/json, s.jina.ai answers with one
			// entry per result in `data`; X-Return-Format shapes each entry's
			// `content` as markdown.
			const body: unknown = await response.json();
			const searchTime = Date.now() - startTime;

			const results = this.parseSearchResults(body, maxResults);

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
	 * Map the `data` entries of a Jina JSON search response to results.
	 * Throws on a body without a `data` array rather than returning an
	 * empty or invented result set.
	 */
	private parseSearchResults(
		body: unknown,
		maxResults: number,
	): SearchResult[] {
		const data = (body as { data?: unknown } | null)?.data;
		if (!Array.isArray(data)) {
			throw new Error(
				"Jina search returned an unexpected response: no data array",
			);
		}

		const results: SearchResult[] = [];
		for (const entry of data as JinaSearchEntry[]) {
			if (results.length >= maxResults) {
				break;
			}
			const url = typeof entry?.url === "string" ? entry.url : "";
			if (!url) {
				continue;
			}
			const content =
				typeof entry.content === "string" ? entry.content : undefined;
			const description =
				typeof entry.description === "string" ? entry.description : "";
			const title =
				typeof entry.title === "string" && entry.title.trim()
					? entry.title
					: this.extractTitleFromUrl(url);
			results.push({
				title,
				url,
				snippet: description || content?.slice(0, 500) || "",
				content,
				publishedDate:
					typeof entry.date === "string" ? entry.date : undefined,
				score: 1 - results.length * 0.1, // Decreasing score for ordering
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

			const response = await fetchSearchEndpoint(readerUrl, {
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

			const response = await fetchSearchEndpoint(testUrl, {
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
