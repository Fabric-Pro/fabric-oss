/**
 * Web Search Tool
 * AI SDK tool for performing web searches using configured providers
 * Supports progress streaming for better UX
 */

import { tool } from "ai";
import { z } from "zod";
import { createProvider } from "../providers";
import type { SearchOptions } from "../types";

/**
 * Web search tool parameters
 * Simplified schema for better LLM compatibility
 */
const webSearchSchema = z.object({
	query: z.string().describe("The search query to execute"),
	maxResults: z
		.number()
		.min(1)
		.max(20)
		.default(10)
		.describe("Maximum number of results"),
});

export type WebSearchParams = z.infer<typeof webSearchSchema>;

interface WebSearchToolConfig {
	apiKey?: string;
	endpoint?: string;
	providerName?: string;
	/** Search category - changes provider behavior for news, academic, etc. */
	category?: "general" | "news" | "academic";
	/** Time range for filtering results */
	timeRange?: "day" | "week" | "month" | "year" | "all";
	/** Data stream for progress updates (AI SDK UIMessageStreamWriter) */
	dataStream?: {
		write: (event: {
			type: string;
			data: unknown;
			transient?: boolean;
		}) => void;
	};
}

export interface WebSearchResult {
	success: boolean;
	error?: string;
	provider?: string;
	searchTime?: number;
	totalResults?: number;
	results: Array<{
		title: string;
		url: string;
		snippet: string;
		content?: string;
		publishedDate?: string;
		author?: string;
		images?: string[];
		favicon?: string;
	}>;
}

/**
 * Progress event types for search operations
 */
export type SearchProgressEvent =
	| { type: "data-search_started"; data: { query: string; provider: string } }
	| {
			type: "data-search_progress";
			data: { query: string; status: string; message: string };
	  }
	| {
			type: "data-search_completed";
			data: { query: string; resultsCount: number; searchTime: number };
	  }
	| { type: "data-search_error"; data: { query: string; error: string } };

/**
 * Create a web search tool with the given configuration
 */
export function createWebSearchTool(config: WebSearchToolConfig = {}) {
	const {
		apiKey,
		endpoint,
		providerName = "exa",
		category = "general",
		timeRange,
		dataStream,
	} = config;

	// Customize description based on category
	const descriptions: Record<string, string> = {
		general:
			"Search the web for current information, recent events, or any topic. Use this to find facts, research topics, or get up-to-date information.",
		news: "Search for recent news articles and current events. Results are filtered to news sources and sorted by recency.",
		academic:
			"Search for academic papers, research articles, and scholarly sources. Results focus on peer-reviewed and educational content.",
	};

	return tool({
		description: descriptions[category] || descriptions.general,
		inputSchema: webSearchSchema,
		execute: async (params: WebSearchParams): Promise<WebSearchResult> => {
			const { query, maxResults } = params;
			const startTime = Date.now();

			// Stream: Search started
			dataStream?.write({
				type: "data-search_started",
				data: { query, provider: providerName },
				transient: true,
			});

			const provider = createProvider(providerName, apiKey, endpoint);

			if (!provider) {
				const errorMsg = `Search provider "${providerName}" is not available`;
				dataStream?.write({
					type: "data-search_error",
					data: { query, error: errorMsg },
					transient: true,
				});
				return {
					success: false,
					error: errorMsg,
					results: [],
				};
			}

			// Stream: Search in progress
			dataStream?.write({
				type: "data-search_progress",
				data: {
					query,
					status: "searching",
					message: `Searching ${providerName}...`,
				},
				transient: true,
			});

			const searchOptions: SearchOptions = {
				maxResults,
				category,
				timeRange:
					timeRange || (category === "news" ? "week" : undefined),
			};

			try {
				// Execute single query search - provider returns SearchResponse object
				const response = await provider.search(query, searchOptions);
				const searchTime = Date.now() - startTime;

				// Stream: Search completed
				dataStream?.write({
					type: "data-search_completed",
					data: {
						query,
						resultsCount: response.results.length,
						searchTime,
					},
					transient: true,
				});

				return {
					success: true,
					provider: response.providerUsed,
					searchTime,
					totalResults: response.results.length,
					results: response.results.map((r) => ({
						title: r.title,
						url: r.url,
						snippet: r.snippet,
						content: r.content,
						publishedDate: r.publishedDate,
						author: r.author,
						images: r.images,
						favicon: r.favicon,
					})),
				};
			} catch (error) {
				const errorMsg =
					error instanceof Error ? error.message : "Search failed";

				// Stream: Search error
				dataStream?.write({
					type: "data-search_error",
					data: { query, error: errorMsg },
					transient: true,
				});

				return {
					success: false,
					error: errorMsg,
					results: [],
				};
			}
		},
	});
}

/**
 * Create a web search tool with progress streaming
 * Pass the dataStream from AI SDK's createUIMessageStream
 */
export function createStreamingWebSearchTool(
	dataStream: WebSearchToolConfig["dataStream"],
	config: Omit<WebSearchToolConfig, "dataStream"> = {},
) {
	return createWebSearchTool({ ...config, dataStream });
}

/**
 * Pre-built web search tool using environment variable configuration
 */
export const webSearchTool = createWebSearchTool();
