/**
 * Unified Search Types
 *
 * Shared result format for project-scoped search across all knowledge sources:
 * project contexts, workspace documents, connector-backed documents, and web.
 *
 * Every result, regardless of source, conforms to the same shape so consumers
 * (agents, deep research, UI) don't need to know which backend produced it.
 */

// =============================================================================
// Source Types
// =============================================================================

/**
 * The origin of a search result. Used for source badges, ranking weights,
 * and transparency in citations.
 */
export type UnifiedSearchSourceType =
	| "project-context" // Project-attached RAG documents
	| "workspace" // Workspace document collections
	| "connector" // Synced external data indexed into workspace docs
	| "artifact" // Reserved for persisted artifacts once artifact persistence ships
	| "web" // Web search results (Exa, Tavily, etc.)
	| "code"; // AST-aware code index (Phase 2)

// =============================================================================
// Unified Search Result
// =============================================================================

export interface UnifiedSearchResult {
	/** Unique ID for this result (chunk ID, search result hash, etc.) */
	id: string;

	/** The text content of this result */
	content: string;

	/** Source metadata for transparency and badges */
	source: {
		type: UnifiedSearchSourceType;
		/** Human-readable name (e.g. "Confluence", "GitHub", "Research Report: Q3") */
		name: string;
		/** Short badge label for UI */
		badge: string;
		/** Link to original content, if available */
		url?: string;
		/** Freshness indicator */
		freshness?: string;
		/** Original filename or document title */
		filename?: string;
	};

	/** Unified relevance score, 0-1. Comparable across source types. */
	relevance: number;

	/** Additional metadata from the source */
	metadata?: Record<string, unknown>;
}

// =============================================================================
// Search Options
// =============================================================================

export interface ProjectSearchOptions {
	/** Project to scope search to */
	projectId: string;

	/** Search query */
	query: string;

	/** User identity (required for tenant isolation) */
	userId: string;

	/** Organization ID (XOR with personal context) */
	organizationId?: string;

	/**
	 * Which sources to include. Defaults to all available.
	 * Omit a source type to skip it.
	 */
	sources?: UnifiedSearchSourceType[];

	/** Max results per source (before merge). Default: 5 */
	perSourceLimit?: number;

	/** Max total results after merge + rank. Default: 10 */
	totalLimit?: number;

	/** Minimum similarity threshold for vector search. Default: 0.4 */
	minSimilarity?: number;

	/**
	 * Workspace IDs attached to the project (for workspace doc search).
	 * If not provided, workspace search is skipped.
	 */
	workspaceIds?: string[];

	/**
	 * Source type weights for final ranking. Higher = boosted.
	 * Defaults to: project-context: 1.0, workspace: 0.9, connector: 0.85, artifact: 0.8, web: 0.7
	 */
	sourceWeights?: Partial<Record<UnifiedSearchSourceType, number>>;

	/**
	 * Federated search function (required if "connector" is in sources).
	 * Injected by the caller to avoid coupling RAG package to connectors package.
	 * Searches live external services (Slack, GitHub) for real-time results.
	 *
	 * @param query - Search query
	 * @param maxResults - Maximum results to return
	 * @returns Array of unified search results from federated connectors
	 */
	federatedSearchFn?: (
		query: string,
		maxResults: number,
	) => Promise<UnifiedSearchResult[]>;

	/**
	 * Web search function (required if "web" is in sources).
	 * Injected by the caller to avoid coupling RAG package to search package.
	 *
	 * @param query - Search query
	 * @param maxResults - Maximum results to return
	 * @returns Array of unified search results from web
	 */
	webSearchFn?: (
		query: string,
		maxResults: number,
	) => Promise<UnifiedSearchResult[]>;

	/**
	 * Code search function (required if "code" is in sources).
	 * Injected by the caller — searches the AST-aware code index in Qdrant.
	 *
	 * @param query - Search query
	 * @param maxResults - Maximum results to return
	 * @returns Array of unified search results from code index
	 */
	codeSearchFn?: (
		query: string,
		maxResults: number,
	) => Promise<UnifiedSearchResult[]>;
}

// =============================================================================
// Search Response
// =============================================================================

export interface ProjectSearchResponse {
	/** Merged, ranked results */
	results: UnifiedSearchResult[];

	/** Per-source result counts (for transparency) */
	sourceCounts: Record<UnifiedSearchSourceType, number>;

	/** Total search time in ms */
	searchTimeMs: number;

	/** Which sources were searched */
	sourcesSearched: UnifiedSearchSourceType[];

	/** Errors from individual sources (non-fatal — other sources still return) */
	sourceErrors?: Record<UnifiedSearchSourceType, string>;
}

// =============================================================================
// Defaults
// =============================================================================

export const DEFAULT_SOURCE_WEIGHTS: Record<UnifiedSearchSourceType, number> = {
	"project-context": 1.0,
	code: 0.95,
	workspace: 0.9,
	connector: 0.85,
	artifact: 0.8,
	web: 0.7,
};

export const DEFAULT_PER_SOURCE_LIMIT = 5;
export const DEFAULT_TOTAL_LIMIT = 10;
export const DEFAULT_MIN_SIMILARITY = 0.4;
