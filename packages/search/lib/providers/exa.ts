/**
 * Exa Search Provider
 * https://exa.ai - AI-native search engine
 */

import { logger } from "@repo/logs";
import Exa from "exa-js";
import type {
	SearchOptions,
	SearchProviderMetadata,
	SearchResponse,
	SearchResult,
	TestConnectionResult,
} from "../types";
import { BaseSearchProvider } from "./base";

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
		.replace(/\[.*?\]/g, "") // Remove [content]
		.replace(/\(.*?\)/g, "") // Remove (content)
		.replace(/\s+/g, " ") // Replace multiple spaces with single space
		.trim();
}

/**
 * Helper function to deduplicate results by URL and domain
 */
function deduplicateResults<T extends { url: string }>(items: T[]): T[] {
	const seenDomains = new Set<string>();
	const seenUrls = new Set<string>();

	return items.filter((item) => {
		const domain = extractDomain(item.url);
		const isNewUrl = !seenUrls.has(item.url);
		const isNewDomain = !seenDomains.has(domain);

		if (isNewUrl && isNewDomain) {
			seenUrls.add(item.url);
			seenDomains.add(domain);
			return true;
		}
		return false;
	});
}

/**
 * Exa search provider implementation
 */
export class ExaSearchProvider extends BaseSearchProvider {
	readonly metadata: SearchProviderMetadata = {
		name: "exa",
		displayName: "Exa",
		description:
			"AI-native search engine that understands queries semantically for more relevant results",
		keyPrefix: "EXA_API_KEY",
		docsUrl: "https://docs.exa.ai",
		icon: "search",
		supportedCategories: ["general", "news", "academic"],
		supportsContentRetrieval: true,
		supportsImageSearch: true,
		rateLimit: 1000, // requests per minute
		costPerSearch: 0.001, // approximately $1 per 1000 searches
	};

	private client: Exa | null = null;

	constructor(apiKey?: string, endpoint?: string) {
		super(apiKey, endpoint);
		if (apiKey) {
			this.client = new Exa(apiKey);
		}
	}

	/**
	 * Initialize the Exa client with API key
	 */
	private getClient(): Exa {
		if (!this.client) {
			if (!this.apiKey) {
				throw new Error("Exa API key is required");
			}
			this.client = new Exa(this.apiKey);
		}
		return this.client;
	}

	/**
	 * Set API key and reinitialize client
	 */
	override setApiKey(apiKey: string): void {
		super.setApiKey(apiKey);
		this.client = new Exa(apiKey);
	}

	/**
	 * Perform a search using Exa
	 */
	async search(
		query: string,
		options: SearchOptions = {},
	): Promise<SearchResponse> {
		const startTime = Date.now();
		const client = this.getClient();

		const {
			maxResults = 10,
			category = "general",
			timeRange,
			includeContent = false,
			includeDomains,
			excludeDomains,
		} = options;

		logger.info(`[ExaSearchProvider] Searching for: "${query}"`, {
			maxResults,
			category,
			timeRange,
		});

		try {
			// Map category to Exa's category format
			type ExaCategory =
				| "news"
				| "research paper"
				| "company"
				| "pdf"
				| "github"
				| "tweet"
				| "personal site"
				| "financial report"
				| "people";
			let exaCategory: ExaCategory | undefined;
			if (category === "news") {
				exaCategory = "news";
			} else if (category === "academic") {
				exaCategory = "research paper";
			}

			logger.info(
				`[ExaSearchProvider] Using Exa category: ${exaCategory || "auto"}`,
			);

			// Calculate time filter if specified
			let startPublishedDate: string | undefined;
			if (timeRange && timeRange !== "all") {
				const now = new Date();
				let startDate: Date;

				switch (timeRange) {
					case "day":
						startDate = new Date(
							now.getTime() - 24 * 60 * 60 * 1000,
						);
						break;
					case "week":
						startDate = new Date(
							now.getTime() - 7 * 24 * 60 * 60 * 1000,
						);
						break;
					case "month":
						startDate = new Date(
							now.getTime() - 30 * 24 * 60 * 60 * 1000,
						);
						break;
					case "year":
						startDate = new Date(
							now.getTime() - 365 * 24 * 60 * 60 * 1000,
						);
						break;
					default:
						startDate = new Date(0);
				}

				startPublishedDate = startDate.toISOString();
			}

			// Build search options
			const searchOptions = {
				type: "auto" as const,
				numResults: Math.max(maxResults, 10), // Minimum 10 for better results
				category: exaCategory,
				includeDomains: includeDomains,
				excludeDomains: excludeDomains,
				startPublishedDate,
			};

			// Use searchAndContents if content is needed, otherwise just search
			let response:
				| Awaited<ReturnType<typeof client.searchAndContents>>
				| undefined;
			if (includeContent) {
				response = await client.searchAndContents(query, {
					...searchOptions,
					text: true,
					highlights: true,
				});
			} else {
				response = await client.search(query, searchOptions);
			}

			// Transform results
			const results: SearchResult[] = response.results.map((result) => ({
				title: cleanTitle(result.title || ""),
				url: result.url,
				snippet:
					(result as any).text?.substring(0, 300) ||
					(result as any).highlights?.[0] ||
					"",
				content: includeContent ? (result as any).text : undefined,
				publishedDate: result.publishedDate || undefined,
				images: result.image ? [result.image] : undefined,
				source: "exa",
				author: result.author || undefined,
				score: result.score,
				favicon: `https://www.google.com/s2/favicons?domain=${extractDomain(result.url)}&sz=32`,
			}));

			// Deduplicate results
			const dedupedResults = deduplicateResults(results).slice(
				0,
				maxResults,
			);

			const searchTime = Date.now() - startTime;
			logger.info(
				`[ExaSearchProvider] Search completed in ${searchTime}ms, found ${dedupedResults.length} results`,
			);

			return {
				results: dedupedResults,
				providerUsed: "exa",
				searchTime,
				totalResults: response.results.length,
				hasMore: response.results.length > maxResults,
			};
		} catch (error) {
			const errorMessage =
				error instanceof Error ? error.message : String(error);
			logger.error(`[ExaSearchProvider] Search failed: ${errorMessage}`);
			throw new Error(`Exa search failed: ${errorMessage}`);
		}
	}

	/**
	 * Retrieve full content from a URL using Exa's getContents
	 */
	async retrieveContent(url: string): Promise<SearchResult | null> {
		try {
			const client = this.getClient();
			const response = await client.getContents([url], {
				text: true,
			});

			if (response.results.length > 0) {
				const result = response.results[0] as any;
				return {
					title: cleanTitle(result.title || ""),
					url: result.url || url,
					snippet: result.text?.substring(0, 300) || "",
					content: result.text || null,
					publishedDate: result.publishedDate || undefined,
					author: result.author || undefined,
					source: "exa",
					favicon: `https://www.google.com/s2/favicons?domain=${extractDomain(url)}&sz=32`,
				};
			}

			return null;
		} catch (error) {
			logger.error(
				`[ExaSearchProvider] Content retrieval failed: ${error instanceof Error ? error.message : String(error)}`,
			);
			return null;
		}
	}

	/**
	 * Check if Exa is available (API key set)
	 */
	async isAvailable(): Promise<boolean> {
		return !!this.apiKey;
	}

	/**
	 * Test the connection to Exa
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
			const client = this.getClient();

			// Perform a minimal search to test the connection
			await client.search("test", {
				numResults: 1,
			});

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
