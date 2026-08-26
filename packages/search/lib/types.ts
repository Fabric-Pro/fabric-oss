/**
 * Types for search providers and tools
 * Follows the pattern established by @repo/rag extraction types
 */

/**
 * Search result from any provider
 */
export interface SearchResult {
	/** Result title */
	title: string;
	/** URL of the source */
	url: string;
	/** Short snippet/description */
	snippet: string;
	/** Full content (if retrieved) */
	content?: string;
	/** Published date of the content */
	publishedDate?: string;
	/** Images found in the result */
	images?: string[];
	/** Source provider name */
	source: string;
	/** Favicon URL */
	favicon?: string;
	/** Author information */
	author?: string;
	/** Relevance score (0-1) */
	score?: number;
	/** Additional metadata */
	metadata?: Record<string, unknown>;
}

/**
 * Video-specific search result
 */
export interface VideoSearchResult extends SearchResult {
	/** Video ID (platform-specific) */
	videoId: string;
	/** Thumbnail URL */
	thumbnailUrl?: string;
	/** Video duration in seconds */
	duration?: number;
	/** View count */
	viewCount?: number;
	/** Channel/creator name */
	channelName?: string;
	/** Channel ID */
	channelId?: string;
}

/**
 * Academic paper search result
 */
export interface AcademicSearchResult extends SearchResult {
	/** Paper DOI */
	doi?: string;
	/** Authors list */
	authors: string[];
	/** Abstract */
	abstract?: string;
	/** Citation count */
	citationCount?: number;
	/** Publication venue */
	venue?: string;
	/** Publication year */
	year?: number;
}

/**
 * Search options for providers
 */
export interface SearchOptions {
	/** Maximum number of results to return */
	maxResults?: number;
	/** Search category */
	category?: "general" | "news" | "academic" | "code";
	/** Time range filter */
	timeRange?: "day" | "week" | "month" | "year" | "all";
	/** Whether to retrieve full content */
	includeContent?: boolean;
	/** Whether to include images */
	includeImages?: boolean;
	/** Domain filter - include only these domains */
	includeDomains?: string[];
	/** Domain filter - exclude these domains */
	excludeDomains?: string[];
	/** Additional provider-specific options */
	providerOptions?: Record<string, unknown>;
}

/**
 * Result of a search operation
 */
export interface SearchResponse {
	/** Search results */
	results: SearchResult[];
	/** Name of the provider used */
	providerUsed: string;
	/** Time taken for search in milliseconds */
	searchTime: number;
	/** Total results available (may be more than returned) */
	totalResults?: number;
	/** Whether more results are available */
	hasMore?: boolean;
	/** Pagination token for next page */
	nextPageToken?: string;
	/** Any warnings or notices */
	warnings?: string[];
}

/**
 * Provider metadata for display and configuration
 */
export interface SearchProviderMetadata {
	/** Unique provider identifier */
	name: string;
	/** Display name for UI */
	displayName: string;
	/** Description of the provider */
	description: string;
	/** API key environment variable prefix */
	keyPrefix?: string;
	/** Documentation URL */
	docsUrl?: string;
	/** Icon URL or icon name */
	icon?: string;
	/** Supported search categories */
	supportedCategories: Array<"general" | "news" | "academic" | "code">;
	/** Whether content retrieval is supported */
	supportsContentRetrieval: boolean;
	/** Whether image search is supported */
	supportsImageSearch: boolean;
	/** Rate limit (requests per minute) */
	rateLimit?: number;
	/** Approximate cost per search (USD) */
	costPerSearch?: number;
}

/**
 * Search modes for the AI chatbot
 */
export type SearchMode =
	| "chat" // No search, direct LLM response
	| "web" // General web search
	| "deep" // Deep research with multiple sources
	| "videos" // YouTube/video search
	| "academic" // Academic papers
	| "news" // Recent news
	| "factcheck"; // Fact verification

/**
 * Configuration for each search mode
 */
export interface SearchModeConfig {
	/** Mode identifier */
	id: SearchMode;
	/** Display label */
	label: string;
	/** Mode description */
	description: string;
	/** Icon name (lucide-react) */
	icon: string;
	/** Tools to enable for this mode */
	tools: string[];
	/** System prompt addition for this mode */
	systemPrompt: string;
	/** Required providers for this mode */
	requiresProvider?: string[];
	/** Keyboard shortcut */
	shortcut?: string;
	/** Search category for providers (changes search behavior) */
	category?: "general" | "news" | "academic";
	/** Time range for filtering results */
	timeRange?: "day" | "week" | "month" | "year" | "all";
}

/**
 * Provider configuration from database
 */
export interface ProviderConfig {
	/** Provider identifier */
	providerName: string;
	/** Decrypted API key */
	apiKey?: string;
	/** Custom endpoint (for self-hosted) */
	endpoint?: string;
	/** Priority in fallback chain (lower = higher priority) */
	priority: number;
	/** Whether this is the default provider */
	isDefault: boolean;
}

/**
 * Search context with tenant information
 */
export interface SearchContext {
	/** User ID for user-level configuration */
	userId?: string;
	/** Organization ID for org-level configuration */
	organizationId?: string;
	/** Preferred search mode */
	mode?: SearchMode;
	/** Override default options */
	options?: SearchOptions;
}

/**
 * Test connection result
 */
export interface TestConnectionResult {
	/** Whether the connection was successful */
	success: boolean;
	/** Error message if failed */
	error?: string;
	/** Response time in milliseconds */
	responseTime?: number;
	/** Additional info (e.g., remaining quota) */
	info?: Record<string, unknown>;
}

/**
 * Deep research plan step
 */
export interface ResearchPlanStep {
	/** Step number */
	step: number;
	/** Description of what this step does */
	description: string;
	/** Search queries to execute */
	queries: string[];
	/** Status of the step */
	status: "pending" | "in_progress" | "completed" | "failed";
}

/**
 * Deep research plan
 */
export interface ResearchPlan {
	/** Research topic */
	topic: string;
	/** Generated research plan steps */
	steps: ResearchPlanStep[];
	/** Overall status */
	status: "planning" | "researching" | "analyzing" | "completed" | "failed";
	/** Progress percentage (0-100) */
	progress: number;
}

/**
 * Fact check source
 */
export interface FactCheckSource {
	/** Source URL */
	url: string;
	/** Source title */
	title: string;
	/** Whether this source supports the claim */
	supports: boolean | null;
	/** Relevant quote from the source */
	quote?: string;
	/** Credibility score (0-1) */
	credibility?: number;
}

/**
 * Fact check result
 */
export interface FactCheckResult {
	/** The claim being checked */
	claim: string;
	/** Verdict */
	verdict: "verified" | "partially_true" | "false" | "unverified";
	/** Explanation of the verdict */
	explanation: string;
	/** Sources used for verification */
	sources: FactCheckSource[];
	/** Confidence in the verdict (0-1) */
	confidence: number;
}
