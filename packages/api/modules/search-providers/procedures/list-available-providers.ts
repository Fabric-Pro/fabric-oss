import { z } from "zod";
import {
	Permissions,
	publicProcedure,
	requirePermission,
} from "../../../orpc/procedures";

/**
 * List all available search providers
 * Public endpoint - no authentication required
 */
export const listAvailableProviders = publicProcedure
	.use(requirePermission(Permissions.ORG_INTEGRATIONS_READ))
	.route({
		method: "GET",
		path: "/search-providers/available",
		tags: ["Search Providers"],
		summary: "List available search providers",
		description:
			"Get a list of all available search providers with their capabilities",
	})
	.output(
		z.array(
			z.object({
				name: z.string(),
				displayName: z.string(),
				description: z.string(),
				docsUrl: z.string().optional(),
				requiresApiKey: z.boolean(),
				supportsContentRetrieval: z.boolean(),
				supportsImageSearch: z.boolean(),
				supportedCategories: z.array(z.string()),
				costPerSearch: z.number(),
			}),
		),
	)
	.handler(async () => {
		return [
			{
				name: "exa",
				displayName: "Exa",
				description:
					"AI-native search engine that understands queries semantically for more relevant results",
				docsUrl: "https://docs.exa.ai",
				requiresApiKey: true,
				supportsContentRetrieval: true,
				supportsImageSearch: true,
				supportedCategories: ["general", "news", "academic"],
				costPerSearch: 0.001,
			},
			{
				name: "tavily",
				displayName: "Tavily",
				description:
					"AI-powered search API optimized for LLMs, providing high-quality, relevant results",
				docsUrl: "https://docs.tavily.com",
				requiresApiKey: true,
				supportsContentRetrieval: true,
				supportsImageSearch: true,
				supportedCategories: ["general", "news"],
				costPerSearch: 0.001,
			},
			{
				name: "firecrawl",
				displayName: "Firecrawl",
				description:
					"Web scraping and content extraction with advanced rendering support",
				docsUrl: "https://docs.firecrawl.dev",
				requiresApiKey: true,
				supportsContentRetrieval: true,
				supportsImageSearch: true,
				supportedCategories: ["general", "news"],
				costPerSearch: 0.001,
			},
			{
				name: "youtube",
				displayName: "YouTube Data API",
				description:
					"Search YouTube videos, channels, and playlists with the official API",
				docsUrl: "https://developers.google.com/youtube/v3",
				requiresApiKey: true,
				supportsContentRetrieval: false,
				supportsImageSearch: false,
				supportedCategories: ["general"],
				costPerSearch: 0,
			},
			{
				name: "parallel",
				displayName: "Parallel",
				description:
					"AI-native web search API built for LLMs with extended webpage excerpts and high-quality results",
				docsUrl: "https://docs.parallel.ai",
				requiresApiKey: true,
				supportsContentRetrieval: true,
				supportsImageSearch: false,
				supportedCategories: ["general", "news"],
				costPerSearch: 0.002,
			},
			{
				name: "jina",
				displayName: "Jina AI",
				description:
					"Web search and content reader API. Powers Fabric AI search and scraping tools (fabric_web_search, fabric_scrape_url).",
				docsUrl: "https://jina.ai/reader",
				requiresApiKey: true,
				supportsContentRetrieval: true,
				supportsImageSearch: false,
				supportedCategories: ["general", "news"],
				costPerSearch: 0.001,
			},
		];
	});
