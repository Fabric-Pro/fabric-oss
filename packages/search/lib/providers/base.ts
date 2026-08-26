/**
 * Base search provider interface
 * Follows the pattern established by @repo/rag extractors
 */

import type {
	SearchOptions,
	SearchProviderMetadata,
	SearchResponse,
	SearchResult,
	TestConnectionResult,
} from "../types";

/**
 * Abstract base class for search providers
 * All providers must extend this class
 */
export abstract class BaseSearchProvider {
	/**
	 * Provider metadata for display and configuration
	 */
	abstract readonly metadata: SearchProviderMetadata;

	/**
	 * API key for the provider (set during initialization)
	 */
	protected apiKey?: string;

	/**
	 * Custom endpoint URL (for self-hosted providers)
	 */
	protected endpoint?: string;

	constructor(apiKey?: string, endpoint?: string) {
		this.apiKey = apiKey;
		this.endpoint = endpoint;
	}

	/**
	 * Perform a search query
	 * @param query - The search query string
	 * @param options - Search options
	 * @returns Search response with results
	 */
	abstract search(
		query: string,
		options?: SearchOptions,
	): Promise<SearchResponse>;

	/**
	 * Perform multiple search queries and merge results
	 * @param queries - Array of search queries
	 * @param options - Search options
	 * @returns Merged and deduplicated search response
	 */
	async multiSearch(
		queries: string[],
		options?: SearchOptions,
	): Promise<SearchResponse> {
		const startTime = Date.now();
		const allResults: SearchResult[] = [];
		const seenUrls = new Set<string>();

		// Execute searches in parallel
		const responses = await Promise.all(
			queries.map((query) => this.search(query, options)),
		);

		// Merge and deduplicate results
		for (const response of responses) {
			for (const result of response.results) {
				if (!seenUrls.has(result.url)) {
					seenUrls.add(result.url);
					allResults.push(result);
				}
			}
		}

		// Sort by score if available
		allResults.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));

		// Limit to maxResults
		const maxResults = options?.maxResults ?? 10;
		const limitedResults = allResults.slice(0, maxResults);

		return {
			results: limitedResults,
			providerUsed: this.metadata.name,
			searchTime: Date.now() - startTime,
			totalResults: allResults.length,
			hasMore: allResults.length > maxResults,
		};
	}

	/**
	 * Retrieve full content from a URL
	 * Default implementation - override in providers that support content retrieval
	 * @param url - URL to retrieve content from
	 * @returns SearchResult with content
	 */
	async retrieveContent(_url: string): Promise<SearchResult | null> {
		if (!this.metadata.supportsContentRetrieval) {
			return null;
		}
		// Override in subclasses that support content retrieval
		return null;
	}

	/**
	 * Check if the provider is available (API key set, service reachable)
	 * @returns Whether the provider is available
	 */
	async isAvailable(): Promise<boolean> {
		// Check if API key is set (if required)
		if (this.metadata.keyPrefix && !this.apiKey) {
			return false;
		}
		return true;
	}

	/**
	 * Test the connection to the provider
	 * @returns Test result with success status and any errors
	 */
	abstract testConnection(): Promise<TestConnectionResult>;

	/**
	 * Get the provider name
	 */
	get name(): string {
		return this.metadata.name;
	}

	/**
	 * Get the display name
	 */
	get displayName(): string {
		return this.metadata.displayName;
	}

	/**
	 * Set the API key (for runtime configuration)
	 */
	setApiKey(apiKey: string): void {
		this.apiKey = apiKey;
	}

	/**
	 * Set the endpoint (for self-hosted providers)
	 */
	setEndpoint(endpoint: string): void {
		this.endpoint = endpoint;
	}
}

/**
 * Interface for provider factory registration
 */
export interface ISearchProvider {
	metadata: SearchProviderMetadata;
	search(query: string, options?: SearchOptions): Promise<SearchResponse>;
	multiSearch(
		queries: string[],
		options?: SearchOptions,
	): Promise<SearchResponse>;
	retrieveContent(url: string): Promise<SearchResult | null>;
	isAvailable(): Promise<boolean>;
	testConnection(): Promise<TestConnectionResult>;
	name: string;
	displayName: string;
	setApiKey(apiKey: string): void;
	setEndpoint(endpoint: string): void;
}
