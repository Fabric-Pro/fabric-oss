/**
 * Types for Tool, Agent, Workflow, and Integration Search
 *
 * Shared type definitions for the search activity modules.
 */

import type { ToolCategory } from "./tool-index";

// =============================================================================
// Tool Search Types
// =============================================================================

export interface SearchAvailableToolsInput {
	/** Natural language description of what you need to do */
	query: string;
	/** Original user query before the LLM rewrote/search-normalized it */
	originalQuery?: string;
	/** Optional category to narrow search */
	category?: ToolCategory;
	/** Maximum number of tools to return */
	limit?: number;
	/** Minimum confidence score (0-1) */
	minConfidence?: number;
	/** Whether to only include read-only tools */
	readOnlyOnly?: boolean;
	/** Whether to use semantic search (slower but more accurate) */
	useSemanticSearch?: boolean;
	/** User ID for MCP config access */
	userId: string;
	/** Organization ID for MCP config access */
	organizationId?: string;
	// SECURITY: Credentials are fetched internally by generateEmbedding()
	// API keys are NOT passed in workflow inputs to avoid storing them in Temporal history
	/** Specific MCP config IDs to search (null = all enabled) */
	enabledMcpConfigIds?: string[] | null;
	/** Specific OAuth integration IDs to search (null = all enabled) */
	enabledIntegrationIds?: string[] | null;
	/** Specific Fabric AI tool IDs to include (null = all, [] = none) */
	enabledFabricToolIds?: string[] | null;
}

export interface SearchAvailableToolsOutput {
	/** Matched tools with confidence scores */
	results: Array<{
		toolId: string;
		serverName: string;
		toolName: string;
		description: string;
		confidence: number;
		matchReason: string;
		category?: ToolCategory;
		riskLevel: "low" | "medium" | "high" | "critical";
		isReadOnly: boolean;
		/** MCP config ID for execution */
		configId: string;
		/** Tool input schema - critical for planner to know what parameters to provide */
		inputSchema?: Record<string, unknown>;
	}>;
	/** Total tools searched */
	totalToolsSearched: number;
	/** Whether semantic search was used */
	semanticSearchUsed: boolean;
	/** Search duration in milliseconds */
	durationMs: number;
	/** Structured telemetry for observability and replay analysis */
	telemetry?: {
		strategy:
			| "explicit_server"
			| "always_available"
			| "fabric_keyword_shortcut"
			| "indexed_keyword_shortcut"
			| "semantic"
			| "semantic_fallback_keyword"
			| "focused_server_fallback"
			| "mentioned_server_fallback";
		matchedServers?: string[];
		explicitServerUsed?: boolean;
		keywordShortcutUsed?: boolean;
	};
}

// =============================================================================
// Agent Search Types
// =============================================================================

export interface SearchAvailableAgentsInput {
	/** Natural language description of what you need to do */
	query: string;
	/** Optional category filter */
	category?: string;
	/** Maximum number of agents to return */
	limit?: number;
	/** Minimum confidence score (0-1) */
	minConfidence?: number;
	/** Exclude agents with these limitations */
	excludeLimitations?: string[];
	/** User ID for agent access */
	userId: string;
	/** Organization ID for agent access */
	organizationId?: string;
	// SECURITY: Credentials are fetched internally by generateEmbedding()
	// API keys are NOT passed in workflow inputs to avoid storing them in Temporal history
	/** Specific agent IDs to search (null = all enabled) */
	enabledAgentIds?: string[] | null;
}

export interface SearchAvailableAgentsOutput {
	/** Matched agents with confidence scores */
	results: Array<{
		agentId: string;
		name: string;
		displayName: string;
		description: string;
		confidence: number;
		matchReason: string;
		skills: string[];
		limitations?: string[];
	}>;
	/** Total agents searched */
	totalAgentsSearched: number;
	/** Search duration in milliseconds */
	durationMs: number;
}

// =============================================================================
// Workflow Search Types
// =============================================================================

export interface SearchAvailableWorkflowsInput {
	/** Natural language description of what you need to do */
	query: string;
	/** Maximum number of workflows to return */
	limit?: number;
	/** Minimum confidence score (0-1) */
	minConfidence?: number;
	/** User ID for workflow access */
	userId: string;
	/** Organization ID for workflow access */
	organizationId?: string;
	// SECURITY: Credentials are fetched internally by generateEmbedding()
	// API keys are NOT passed in workflow inputs to avoid storing them in Temporal history
	/** Specific workflow name to search for (from explicit mention) */
	requestedWorkflowName?: string;
}

export interface SearchAvailableWorkflowsOutput {
	/** Matched workflows with confidence scores */
	results: Array<{
		workflowId: string;
		name: string;
		description: string;
		confidence: number;
		matchReason: string;
		triggerType: string;
		status: string;
	}>;
	/** Total workflows searched */
	totalWorkflowsSearched: number;
	/** Search duration in milliseconds */
	durationMs: number;
}

// =============================================================================
// Integration Search Types
// =============================================================================

export interface SearchAvailableIntegrationsInput {
	/** Natural language description of what you need to do */
	query: string;
	/** Optional provider to filter by */
	provider?: string;
	/** Maximum number of integrations to return */
	limit?: number;
	/** Minimum confidence score (0-1) */
	minConfidence?: number;
	/** User ID for integration access */
	userId: string;
	/** Organization ID for integration access */
	organizationId?: string;
	// SECURITY: Credentials are fetched internally by generateEmbedding()
	// API keys are NOT passed in workflow inputs to avoid storing them in Temporal history
	/** Specific integration IDs to search (null = all enabled) */
	enabledIntegrationIds?: string[] | null;
	/**
	 * Restrict results to integrations the given surface can actually execute,
	 * using `@repo/integrations/executor-registry` as the source of truth.
	 * Applied as a database predicate before scoring and `limit`.
	 *
	 * Omit for the planner/routing path — the step executor supports providers
	 * the chat loop cannot run, and filtering them out would silently shrink its
	 * options.
	 */
	executionSurface?: "LOOM_CHAT";
}

export interface SearchAvailableIntegrationsOutput {
	/** Matched integrations with confidence scores */
	results: Array<{
		integrationId: string;
		name: string;
		provider: string;
		description: string;
		confidence: number;
		matchReason: string;
		capabilities: string[];
		operations: Array<{
			name: string;
			description: string;
			/** Present only when `executionSurface: "LOOM_CHAT"` was requested. */
			inputSchema?: Record<string, unknown>;
		}>;
		isActive: boolean;
	}>;
	/** Total integrations searched */
	totalIntegrationsSearched: number;
	/** Search duration in milliseconds */
	durationMs: number;
}

// =============================================================================
// Integration Provider Metadata
// =============================================================================

export interface IntegrationProviderMetadata {
	description: string;
	capabilities: string[];
	/**
	 * `inputSchema` is populated ONLY on the LOOM_CHAT projection, where the
	 * model needs each operation's real argument contract. The default
	 * (planner) projection deliberately omits it so its output stays exactly
	 * as it was before chat discovery existed.
	 */
	operations: Array<{
		name: string;
		description: string;
		inputSchema?: Record<string, unknown>;
	}>;
	/** KEYWORDS for BM25-style deterministic matching (Anthropic Tool Search Pattern) */
	keywords?: string[];
}
