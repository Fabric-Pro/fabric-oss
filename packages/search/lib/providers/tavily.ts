/**
 * Tavily Search Provider
 * https://tavily.com - AI-powered search API
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

/**
 * Tavily API response types
 */
interface TavilySearchResult {
	title: string;
	url: string;
	content: string;
	score?: number;
	published_date?: string;
	author?: string;
}

interface TavilyImage {
	url: string;
	description?: string;
}

interface TavilySearchResponse {
	query: string;
	results: TavilySearchResult[];
	images?: TavilyImage[];
	answer?: string;
	response_time: number;
}

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
 * Helper function to clean title text
 */
function cleanTitle(title: string): string {
	return title
		.replace(/\[.*?\]/g, "")
		.replace(/\(.*?\)/g, "")
		.replace(/\s+/g, " ")
		.trim();
}

/**
 * Tavily search provider implementation
 */
export class TavilySearchProvider extends BaseSearchProvider {
	readonly metadata: SearchProviderMetadata = {
		name: "tavily",
		displayName: "Tavily",
		description:
			"AI-powered search API optimized for LLMs, providing high-quality, relevant results",
		keyPrefix: "TAVILY_API_KEY",
		docsUrl: "https://docs.tavily.com",
		icon: "globe",
		supportedCategories: ["general", "news"],
		supportsContentRetrieval: true,
		supportsImageSearch: true,
		rateLimit: 1000,
		costPerSearch: 0.001,
	};

	private baseUrl = "https://api.tavily.com";

	constructor(apiKey?: string, endpoint?: string) {
		super(apiKey, endpoint);
		if (endpoint) {
			this.baseUrl = endpoint;
		}
	}

	/**
	 * Perform a search using Tavily API
	 */
	async search(
		query: string,
		options: SearchOptions = {},
	): Promise<SearchResponse> {
		const startTime = Date.now();

		if (!this.apiKey) {
			throw new Error("Tavily API key is required");
		}

		const {
			maxResults = 10,
			category = "general",
			timeRange,
			includeContent = true,
			includeImages = true,
			includeDomains,
			excludeDomains,
		} = options;

		logger.info(`[TavilySearchProvider] Searching for: "${query}"`, {
			maxResults,
			category,
			timeRange,
		});

		try {
			// Build request body
			const requestBody: Record<string, unknown> = {
				api_key: this.apiKey,
				query,
				max_results: maxResults,
				search_depth: "basic",
				include_answer: true,
				include_images: includeImages,
				include_image_descriptions: true,
			};

			// Set topic based on category
			if (category === "news") {
				requestBody.topic = "news";
				// For news, limit to recent articles
				if (timeRange === "day") {
					requestBody.days = 1;
				} else if (timeRange === "week") {
					requestBody.days = 7;
				} else if (timeRange === "month") {
					requestBody.days = 30;
				} else {
					requestBody.days = 7; // Default to 7 days for news
				}
			} else {
				requestBody.topic = "general";
			}

			// Add domain filters
			if (includeDomains?.length) {
				requestBody.include_domains = includeDomains;
			}
			if (excludeDomains?.length) {
				requestBody.exclude_domains = excludeDomains;
			}

			// Make API request
			const response = await fetch(`${this.baseUrl}/search`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
				},
				body: JSON.stringify(requestBody),
			});

			if (!response.ok) {
				const errorText = await response.text();
				throw new Error(
					`Tavily API error: ${response.status} - ${errorText}`,
				);
			}

			const data: TavilySearchResponse = await response.json();

			// Transform results
			const results: SearchResult[] = data.results.map((result) => ({
				title: cleanTitle(result.title),
				url: result.url,
				snippet: result.content.substring(0, 300),
				content: includeContent ? result.content : undefined,
				publishedDate: result.published_date || undefined,
				source: "tavily",
				author: result.author || undefined,
				score: result.score,
				favicon: `https://www.google.com/s2/favicons?domain=${extractDomain(result.url)}&sz=32`,
			}));

			// Add images to results if available
			if (data.images?.length) {
				for (
					let i = 0;
					i < results.length && i < data.images.length;
					i++
				) {
					if (!results[i].images) {
						results[i].images = [];
					}
					results[i].images?.push(data.images[i].url);
				}
			}

			const searchTime = Date.now() - startTime;
			logger.info(
				`[TavilySearchProvider] Search completed in ${searchTime}ms, found ${results.length} results`,
			);

			return {
				results,
				providerUsed: "tavily",
				searchTime,
				totalResults: results.length,
				hasMore: false,
			};
		} catch (error) {
			const errorMessage =
				error instanceof Error ? error.message : String(error);
			logger.error(
				`[TavilySearchProvider] Search failed: ${errorMessage}`,
			);
			throw new Error(`Tavily search failed: ${errorMessage}`);
		}
	}

	/**
	 * Retrieve content from a URL
	 * Tavily's search already includes content, so this uses the extract endpoint
	 */
	async retrieveContent(url: string): Promise<SearchResult | null> {
		if (!this.apiKey) {
			return null;
		}

		try {
			const response = await fetch(`${this.baseUrl}/extract`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					api_key: this.apiKey,
					urls: [url],
				}),
			});

			if (!response.ok) {
				return null;
			}

			const data = await response.json();
			if (data.results?.[0]) {
				const result = data.results[0];
				const content = result.raw_content || result.content || "";
				return {
					title: result.title || "",
					url: result.url || url,
					snippet: content.substring(0, 300),
					content: content,
					source: "tavily",
					favicon: `https://www.google.com/s2/favicons?domain=${new URL(url).hostname}&sz=32`,
				};
			}

			return null;
		} catch (error) {
			logger.error(
				`[TavilySearchProvider] Content retrieval failed: ${error instanceof Error ? error.message : String(error)}`,
			);
			return null;
		}
	}

	/**
	 * Check if Tavily is available
	 */
	async isAvailable(): Promise<boolean> {
		return !!this.apiKey;
	}

	/**
	 * Test the connection to Tavily
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
			const response = await fetch(`${this.baseUrl}/search`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					api_key: this.apiKey,
					query: "test",
					max_results: 1,
				}),
			});

			if (!response.ok) {
				const errorText = await response.text();
				return {
					success: false,
					error: `API error: ${response.status} - ${errorText}`,
					responseTime: Date.now() - startTime,
				};
			}

			return {
				success: true,
				responseTime: Date.now() - startTime,
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
