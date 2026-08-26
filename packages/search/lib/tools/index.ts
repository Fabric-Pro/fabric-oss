/**
 * Search Tools for AI SDK
 * Pre-built tools for web search, content retrieval, and more
 */

// Content Retrieval
export {
	type ContentRetrieveParams,
	contentRetrieveTool,
	createContentRetrieveTool,
} from "./content-retrieve";
// Web Search
export {
	createStreamingWebSearchTool,
	createWebSearchTool,
	type SearchProgressEvent,
	type WebSearchParams,
	type WebSearchResult,
	webSearchTool,
} from "./web-search";
