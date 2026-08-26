/**
 * Report Template Instance Types
 *
 * Type definitions for the reporting system including:
 * - Data source definitions and handlers
 * - RAG processing configuration
 * - Execution context and results
 */

// =============================================================================
// Data Source Types
// =============================================================================

/**
 * Explicit data source type - templates must specify this
 */
export type DataSourceType =
	| "mcp" // Requires MCP server config
	| "integration" // Requires Workflow Integration
	| "workspace" // Requires workspace selection
	| "user-input" // User provides data at runtime
	| "fabric"; // Internal Fabric patterns (YouTube, etc.)

/**
 * Fetch mode for data sources
 */
export type FetchMode =
	| "full" // Fetch all data every time
	| "incremental" // Fetch only new data since last run
	| "date_range"; // Fetch data within specified date range

/**
 * Data processing configuration for RAG
 */
export interface DataProcessingConfig {
	/** Target chunk size in characters */
	chunkSize: number;
	/** Overlap between chunks */
	chunkOverlap: number;
	/** Whether to embed chunks in Qdrant for RAG */
	embedForRag: boolean;
	/** Pre-summarize chunks before embedding (for very large datasets) */
	summarizeChunks: boolean;
}

/**
 * Data source definition in template
 */
export interface DataSourceDefinition {
	/** Unique identifier for this data source */
	id: string;
	/** Explicit type - MCP, Integration, etc. */
	type: DataSourceType;
	/** Provider name (slack, github, linear, etc.) */
	provider: string;
	/** Operation/tool to execute */
	operation: string;
	/** Operation-specific configuration */
	config: {
		/** Arguments to pass to the operation */
		args?: Record<string, unknown>;
		/** Fetch mode for incremental support */
		fetchMode?: FetchMode;
		/** Maximum records to fetch */
		limit?: number;
		/** Custom configuration */
		[key: string]: unknown;
	};
	/** RAG processing configuration */
	processing?: Partial<DataProcessingConfig>;
}

// =============================================================================
// Connection Types
// =============================================================================

/**
 * Resource binding (channel, board, repo, etc.)
 */
export interface ResourceBinding {
	resourceId: string;
	resourceName: string;
	resourceType: string;
}

/**
 * Instance connections - user's bound credentials
 */
export interface InstanceConnections {
	/** MCP bindings: dataSourceId -> mcpConfigId */
	mcpBindings?: Record<string, string>;
	/** Integration bindings: dataSourceId -> integrationId or provider name */
	integrationBindings?: Record<string, string>;
	/** Resource selections (channels, boards, repos, etc.) */
	resourceBindings?: Record<string, ResourceBinding>;
	/** Workspace bindings for RAG context */
	workspaceBindings?: Record<string, string>;
	/** Parameter bindings: dataSourceId -> { paramKey: paramValue } for operation-specific parameters */
	parameterBindings?: Record<string, Record<string, string>>;
	/** Legacy: array of MCP config IDs */
	mcpConfigs?: string[];
	/** Legacy: array of integration IDs */
	integrations?: string[];
	/** Legacy: array of workspace IDs */
	workspaces?: string[];
}

// =============================================================================
// Fetch Context and Results
// =============================================================================

/**
 * Context passed to data source handlers
 */
export interface FetchContext {
	userId: string;
	organizationId?: string;
	executionId: string;
	parameters: Record<string, unknown>;
	dateRange?: {
		start: string;
		end: string;
	};
}

/**
 * Result from data source fetch
 */
export interface FetchResult {
	success: boolean;
	data: unknown[];
	recordCount: number;
	hasMore: boolean;
	cursor?: string;
	metadata: {
		provider: string;
		operation: string;
		fetchedAt: string;
		latestTimestamp?: string;
	};
	error?: string;
}

/**
 * State for incremental fetching
 */
export interface IncrementalFetchState {
	dataSourceId: string;
	lastFetchTimestamp: string;
	lastCursor?: string;
	lastRecordCount: number;
}

// =============================================================================
// RAG Processing Types
// =============================================================================

/**
 * Text chunk for RAG indexing
 */
export interface TextChunk {
	content: string;
	metadata: {
		dataSourceId: string;
		itemIndex: number;
		chunkIndex: number;
		timestamp?: string;
		[key: string]: unknown;
	};
}

/**
 * Result from RAG processing
 */
export interface RagProcessingResult {
	collectionName: string;
	chunkCount: number;
	bytesProcessed: number;
}

/**
 * Retrieved chunk from Qdrant
 */
export interface RetrievedChunk {
	content: string;
	similarity: number;
	metadata: Record<string, unknown>;
}

// =============================================================================
// AI Analysis Types
// =============================================================================

/**
 * AI task definition from template
 */
export interface AiTaskDefinition {
	agentId: string;
	task: string;
	outputVariable?: string;
	systemPrompt?: string;
}

/**
 * Result from AI analysis
 */
export interface AiAnalysisResult {
	agentId: string;
	task: string;
	output: string;
	outputVariable?: string;
	chunksUsed?: number;
	error?: string;
}

// =============================================================================
// Execution Types
// =============================================================================

/**
 * Data source result with processing info
 */
export interface DataSourceResult {
	sourceId: string;
	sourceType: DataSourceType;
	provider: string;
	data: unknown;
	recordCount: number;
	ragProcessing?: RagProcessingResult;
	error?: string;
}

/**
 * Complete execution context
 */
export interface ExecutionContext extends FetchContext {
	/** Qdrant collection for this execution */
	qdrantCollectionId?: string;
	/** Previous fetch states for incremental mode */
	previousFetchStates?: Record<string, IncrementalFetchState>;
	/** Fabric AI enriched system prompt */
	enrichedSystemPrompt?: string;
}

/**
 * Rendered report output
 */
export interface RenderedReport {
	markdown: string;
	title: string;
	generatedAt: string;
}

// =============================================================================
// Handler Interface
// =============================================================================

/**
 * Data source handler interface
 */
export interface DataSourceHandler {
	/** Handler type */
	type: DataSourceType;
	/** Supported providers */
	supportedProviders: string[];

	/**
	 * Validate that the user has configured this connection
	 */
	validateConnection(
		dataSource: DataSourceDefinition,
		connections: InstanceConnections,
		userId: string,
		organizationId?: string,
	): Promise<{ valid: boolean; error?: string }>;

	/**
	 * Fetch data from the source
	 */
	fetchData(
		dataSource: DataSourceDefinition,
		connections: InstanceConnections,
		context: FetchContext,
	): Promise<FetchResult>;

	/**
	 * Get incremental data since last fetch (optional)
	 */
	fetchIncremental?(
		dataSource: DataSourceDefinition,
		lastTimestamp: string,
		connections: InstanceConnections,
		context: FetchContext,
	): Promise<FetchResult>;
}

// =============================================================================
// Default Processing Config
// =============================================================================

export const DEFAULT_PROCESSING_CONFIG: DataProcessingConfig = {
	chunkSize: 1000,
	chunkOverlap: 100,
	embedForRag: false,
	summarizeChunks: false,
};

/**
 * Get processing config with defaults
 */
export function getProcessingConfig(
	partial?: Partial<DataProcessingConfig>,
): DataProcessingConfig {
	return {
		...DEFAULT_PROCESSING_CONFIG,
		...partial,
	};
}

// =============================================================================
// MCP Connection Diagnostic Types
// =============================================================================

/** Outcome of attempting to use one MCP config for report data gathering. */
export type McpConnectionOutcome =
	| "connected" // >=1 read-only tool usable
	| "auth_failed" // 401/403, token/unauthorized/expired
	| "unreachable" // timeout / ECONNREFUSED / DNS / network
	| "zero_tools" // connected but server exposed no tools
	| "no_read_only_tools" // tools exist, none read-only
	| "error"; // any other failure

/** Per-server diagnostic captured during agentic data gathering. */
export interface McpServerDiagnostic {
	configId: string;
	serverName: string;
	provider?: string;
	outcome: McpConnectionOutcome;
	toolCount: number;
	readOnlyToolCount: number;
	/** Sanitized (redacted) error message; never contains secrets/tokens. */
	errorMessage?: string;
}

/** Whether an outcome is user-recoverable via a Reconnect action. */
export function isRecoverableOutcome(outcome: McpConnectionOutcome): boolean {
	return outcome === "auth_failed" || outcome === "unreachable";
}
