/**
 * Firecrawl Search Provider
 * https://firecrawl.dev - Web scraping and content extraction
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

const FIRECRAWL_API_BASE = "https://api.firecrawl.dev/v1";

/**
 * Helper function to extract domain from URL
 */
function extractDomain(url: string): string {
	try {
		const urlObj = new URL(url);
		return urlObj.hostname;
	} catch {
		return url;
	}
}

/**
 * Firecrawl search provider implementation
 * Primarily used for web scraping and content extraction
 */
export class FirecrawlSearchProvider extends BaseSearchProvider {
	readonly metadata: SearchProviderMetadata = {
		name: "firecrawl",
		displayName: "Firecrawl",
		description:
			"Web scraping and content extraction with advanced rendering support",
		keyPrefix: "FIRECRAWL_API_KEY",
		docsUrl: "https://docs.firecrawl.dev",
		icon: "globe",
		supportedCategories: ["general"],
		supportsContentRetrieval: true,
		supportsImageSearch: false,
		rateLimit: 100, // requests per minute
		costPerSearch: 0.001,
	};

	constructor(apiKey?: string, endpoint?: string) {
		super(apiKey, endpoint || FIRECRAWL_API_BASE);
	}

	/**
	 * Get the API endpoint
	 */
	private getEndpoint(): string {
		return this.endpoint || FIRECRAWL_API_BASE;
	}

	/**
	 * Perform a search using Firecrawl
	 */
	async search(
		query: string,
		options: SearchOptions = {},
	): Promise<SearchResponse> {
		const startTime = Date.now();

		if (!this.apiKey) {
			throw new Error("Firecrawl API key is required");
		}

		const { maxResults = 10 } = options;

		logger.info(`[FirecrawlSearchProvider] Searching for: "${query}"`, {
			maxResults,
		});

		try {
			const response = await fetch(`${this.getEndpoint()}/search`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${this.apiKey}`,
				},
				body: JSON.stringify({
					query,
					limit: maxResults,
				}),
			});

			if (!response.ok) {
				const errorText = await response.text();
				throw new Error(
					`Firecrawl API error: ${response.status} - ${errorText}`,
				);
			}

			const data = await response.json();

			if (!data.success) {
				throw new Error(data.error || "Firecrawl search failed");
			}

			// Transform results
			const results: SearchResult[] = (data.data || []).map(
				(result: any) => ({
					title: result.title || result.url || "",
					url: result.url,
					snippet:
						result.description ||
						result.markdown?.substring(0, 300) ||
						"",
					content: result.markdown || result.rawHtml || null,
					source: "firecrawl",
					favicon: `https://www.google.com/s2/favicons?domain=${extractDomain(result.url)}&sz=32`,
				}),
			);

			const searchTime = Date.now() - startTime;
			logger.info(
				`[FirecrawlSearchProvider] Search completed in ${searchTime}ms, found ${results.length} results`,
			);

			return {
				results,
				providerUsed: "firecrawl",
				searchTime,
				totalResults: results.length,
				hasMore: false,
			};
		} catch (error) {
			const errorMessage =
				error instanceof Error ? error.message : String(error);
			logger.error(
				`[FirecrawlSearchProvider] Search failed: ${errorMessage}`,
			);
			throw new Error(`Firecrawl search failed: ${errorMessage}`);
		}
	}

	/**
	 * Scrape a URL and retrieve its content
	 */
	async retrieveContent(url: string): Promise<SearchResult | null> {
		if (!this.apiKey) {
			throw new Error("Firecrawl API key is required");
		}

		logger.info(`[FirecrawlSearchProvider] Scraping URL: ${url}`);

		try {
			const response = await fetch(`${this.getEndpoint()}/scrape`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${this.apiKey}`,
				},
				body: JSON.stringify({
					url,
					formats: ["markdown"],
				}),
			});

			if (!response.ok) {
				const errorText = await response.text();
				throw new Error(
					`Firecrawl API error: ${response.status} - ${errorText}`,
				);
			}

			const data = await response.json();

			if (!data.success) {
				throw new Error(data.error || "Firecrawl scrape failed");
			}

			const result = data.data;
			return {
				title: result.metadata?.title || result.title || "",
				url: result.metadata?.sourceURL || url,
				snippet:
					result.metadata?.description ||
					result.markdown?.substring(0, 300) ||
					"",
				content: result.markdown || result.rawHtml || null,
				source: "firecrawl",
				favicon: `https://www.google.com/s2/favicons?domain=${extractDomain(url)}&sz=32`,
			};
		} catch (error) {
			logger.error(
				`[FirecrawlSearchProvider] Content retrieval failed: ${error instanceof Error ? error.message : String(error)}`,
			);
			return null;
		}
	}

	/**
	 * Check if Firecrawl is available (API key set)
	 */
	async isAvailable(): Promise<boolean> {
		return !!this.apiKey;
	}

	/**
	 * Test the connection to Firecrawl
	 */
	async testConnection(): Promise<TestConnectionResult> {
		const startTime = Date.now();

		if (!this.apiKey) {
			return {
				success: false,
				error: "API key not configured",
			};
		}

		try {
			// Perform a minimal scrape to test the connection
			const response = await fetch(`${this.getEndpoint()}/scrape`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${this.apiKey}`,
				},
				body: JSON.stringify({
					url: "https://example.com",
					formats: ["markdown"],
				}),
			});

			const responseTime = Date.now() - startTime;

			if (response.status === 401 || response.status === 403) {
				return {
					success: false,
					error: "Invalid API key",
					responseTime,
				};
			}

			if (response.status === 402) {
				return {
					success: false,
					error: "No credits remaining",
					responseTime,
				};
			}

			if (response.status === 429) {
				return {
					success: false,
					error: "Rate limit exceeded",
					responseTime,
				};
			}

			if (!response.ok) {
				const errorText = await response.text();
				return {
					success: false,
					error: `API error: ${response.status} - ${errorText}`,
					responseTime,
				};
			}

			const data = await response.json();

			return {
				success: data.success === true,
				error: data.success ? undefined : data.error,
				responseTime,
				info: {
					creditsUsed: data.creditsUsed,
				},
			};
		} catch (error) {
			return {
				success: false,
				error: error instanceof Error ? error.message : String(error),
				responseTime: Date.now() - startTime,
			};
		}
	}
}
