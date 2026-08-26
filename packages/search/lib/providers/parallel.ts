/**
 * Parallel AI Search Provider
 * https://parallel.ai - AI-native web search API built for LLMs
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
 * Parallel API response types
 */
interface ParallelSearchResult {
	url: string;
	title: string;
	publish_date?: string | null;
	excerpts: string[];
}

interface ParallelSearchResponse {
	results: ParallelSearchResult[];
	warnings?: string[] | null;
	usage?: Array<{
		name: string;
		count: number;
	}>;
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
 * Parallel search provider implementation
 */
export class ParallelSearchProvider extends BaseSearchProvider {
	readonly metadata: SearchProviderMetadata = {
		name: "parallel",
		displayName: "Parallel",
		description:
			"AI-native web search API built for LLMs, providing extended webpage excerpts and high-quality results",
		keyPrefix: "PARALLEL_API_KEY",
		docsUrl: "https://docs.parallel.ai",
		icon: "globe",
		supportedCategories: ["general", "news"],
		supportsContentRetrieval: true,
		supportsImageSearch: false, // Parallel doesn't return images
		rateLimit: 1000,
		costPerSearch: 0.002, // Base tier pricing
	};

	private baseUrl = "https://api.parallel.ai";

	constructor(apiKey?: string, endpoint?: string) {
		super(apiKey, endpoint);
		if (endpoint) {
			this.baseUrl = endpoint;
		}
	}

	/**
	 * Perform a search using Parallel API
	 */
	async search(
		query: string,
		options: SearchOptions = {},
	): Promise<SearchResponse> {
		const startTime = Date.now();

		if (!this.apiKey) {
			throw new Error("Parallel API key is required");
		}

		const { maxResults = 10, category = "general" } = options;

		logger.info(`[ParallelSearchProvider] Searching for: "${query}"`, {
			maxResults,
			category,
		});

		try {
			// Determine processor based on category
			// "base" is fast (2-5s), "pro" is thorough (15-60s)
			const processor = category === "news" ? "pro" : "base";
			const maxCharsPerResult = 3000; // Extended excerpts for LLM consumption

			// Build request body
			const requestBody = {
				objective: query,
				search_queries: [query],
				processor,
				max_results: maxResults,
				max_chars_per_result: maxCharsPerResult,
			};

			// Make API request
			const response = await fetch(`${this.baseUrl}/v1beta/search`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"x-api-key": this.apiKey,
				},
				body: JSON.stringify(requestBody),
			});

			if (!response.ok) {
				const errorText = await response.text();
				throw new Error(
					`Parallel API error: ${response.status} - ${errorText}`,
				);
			}

			const data: ParallelSearchResponse = await response.json();

			// Transform results
			const results: SearchResult[] = data.results.map((result) => {
				// Combine excerpts into content
				const content = result.excerpts?.join("\n\n") || "";
				const snippet = content.substring(0, 300);

				return {
					title: result.title,
					url: result.url,
					snippet,
					content,
					publishedDate: result.publish_date || undefined,
					source: "parallel",
					favicon: `https://www.google.com/s2/favicons?domain=${extractDomain(result.url)}&sz=32`,
				};
			});

			const searchTime = Date.now() - startTime;
			logger.info(
				`[ParallelSearchProvider] Search completed in ${searchTime}ms, found ${results.length} results`,
			);

			return {
				results,
				providerUsed: "parallel",
				searchTime,
				totalResults: results.length,
				hasMore: false,
			};
		} catch (error) {
			const errorMessage =
				error instanceof Error ? error.message : String(error);
			logger.error(
				`[ParallelSearchProvider] Search failed: ${errorMessage}`,
			);
			throw new Error(`Parallel search failed: ${errorMessage}`);
		}
	}

	/**
	 * Check if Parallel is available
	 */
	async isAvailable(): Promise<boolean> {
		return !!this.apiKey;
	}

	/**
	 * Test the connection to Parallel
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
			const response = await fetch(`${this.baseUrl}/v1beta/search`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"x-api-key": this.apiKey,
				},
				body: JSON.stringify({
					objective: "test connection",
					search_queries: ["test"],
					processor: "base",
					max_results: 1,
					max_chars_per_result: 100,
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
