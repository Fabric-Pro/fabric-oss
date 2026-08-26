/**
 * Content Retrieval Tool
 * AI SDK tool for extracting content from URLs
 */

import { tool } from "ai";
import { z } from "zod";
import { createProvider } from "../providers";

/**
 * Content retrieval tool parameters
 */
const contentRetrieveSchema = z.object({
	url: z.string().url().describe("The URL to retrieve content from"),
	extractType: z
		.enum(["full", "summary", "metadata"])
		.default("full")
		.describe(
			"Type of content extraction: full for complete content, summary for condensed version, metadata for page info only",
		),
});

export type ContentRetrieveParams = z.infer<typeof contentRetrieveSchema>;

interface ContentRetrieveToolConfig {
	apiKey?: string;
	endpoint?: string;
	providerName?: string;
}

interface ContentRetrieveResult {
	success: boolean;
	error?: string;
	title?: string;
	url?: string;
	author?: string;
	publishedDate?: string;
	snippet?: string;
	content?: string | null;
	images?: string[];
}

/**
 * Create a content retrieval tool with the given configuration
 */
export function createContentRetrieveTool(
	config: ContentRetrieveToolConfig = {},
) {
	const { apiKey, endpoint, providerName = "exa" } = config;

	return tool({
		description:
			"Retrieve and extract content from a specific URL. Use this to get detailed information from a webpage, article, or document. The tool can extract full content, a summary, or just metadata.",
		inputSchema: contentRetrieveSchema,
		execute: async (
			params: ContentRetrieveParams,
		): Promise<ContentRetrieveResult> => {
			const { url, extractType } = params;

			const provider = createProvider(providerName, apiKey, endpoint);

			if (!provider) {
				return {
					success: false,
					error: `Content retrieval provider "${providerName}" is not available`,
				};
			}

			try {
				const result = await provider.retrieveContent(url);

				if (!result) {
					return {
						success: false,
						error: "Failed to retrieve content from URL",
					};
				}

				// Process based on extract type
				let content = result.content;

				if (extractType === "metadata") {
					return {
						success: true,
						title: result.title,
						url: result.url,
						author: result.author,
						publishedDate: result.publishedDate,
						snippet: result.snippet,
					};
				}

				if (extractType === "summary" && content) {
					// For summary, truncate to first 2000 characters
					content =
						content.length > 2000
							? `${content.substring(0, 2000)}...`
							: content;
				}

				return {
					success: true,
					title: result.title,
					url: result.url,
					author: result.author,
					publishedDate: result.publishedDate,
					content,
					images: result.images,
				};
			} catch (error) {
				return {
					success: false,
					error:
						error instanceof Error
							? error.message
							: "Content retrieval failed",
				};
			}
		},
	});
}

/**
 * Pre-built content retrieval tool using environment variable configuration
 */
export const contentRetrieveTool = createContentRetrieveTool();
