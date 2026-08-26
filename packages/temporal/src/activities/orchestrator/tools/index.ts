/**
 * Tools Module
 *
 * Provides dynamic tool and capability discovery for the orchestrator.
 * Implements token-efficient patterns from Anthropic's Advanced Tool Use.
 *
 * Module Structure:
 * - types.ts: Shared type definitions
 * - utils.ts: Utility functions (cosineSimilarity, extractQueryWords)
 * - tool-definitions.ts: LLM tool schemas for meta-tools
 * - fabric-ai-tools.ts: Virtual Fabric AI tool definitions
 * - search-tools.ts: MCP tool search
 * - search-agents.ts: Agent search
 * - search-workflows.ts: Workflow search
 * - search-integrations.ts: Integration search + provider metadata
 */

// Approval Tool
export {
	APPROVAL_SYSTEM_PROMPT,
	getApprovalToolDefinition,
	type RequestApprovalInput,
	type RequestApprovalOutput,
	requestApprovalToolDefinition,
} from "./approval-tool";
// Capability Cache (types only — the singleton is superseded by the multi-level
// Redis + DB cache in agent-capabilities.ts. Class/instance are no longer exported
// to avoid accidental use of the stale in-memory-only path.)
export type { CacheEntry, CacheStats } from "./capability-cache";
// Capability Embeddings
export {
	cosineSimilarity,
	EmbeddingCache,
	type EmbeddingCacheEntry,
	type EmbeddingCacheOptions,
	type EmbeddingSearchResult,
	embeddingCache,
	getOrGenerateEmbedding,
	getOrGenerateEmbeddings,
	hybridScore,
	mergeSearchResults,
	semanticSearch,
	semanticSearchPrecomputed,
} from "./capability-embeddings";
// Capability Keywords (BM25-style matching)
export {
	ALWAYS_AVAILABLE_CAPABILITIES,
	agentToCapabilityWithKeywords,
	type CapabilityWithKeywords,
	calculateKeywordMatchScore,
	extractImplicitKeywords,
	extractKeywordsFromDescription,
	type KeywordMatch,
	type KeywordSearchOptions,
	matchAlwaysAvailableCapabilities,
	searchByKeywords,
	toolToCapabilityWithKeywords,
} from "./capability-keywords";
// Connection Detection
export {
	checkServerConnection,
	type DetectMissingIntegrationsInput,
	type DetectMissingIntegrationsOutput,
	type DetectRequiredConnectionsInput,
	type DetectRequiredConnectionsOutput,
	detectMissingIntegrations,
	detectRequiredConnections,
	detectRequiredConnectionsWithRegistrySearch,
	type MissingIntegration,
	searchSystemServersForTask,
} from "./detect-required-connections";
// Fabric AI Tools
export {
	type FabricAiTool,
	getAllFabricAiTools,
	getFabricAiTools,
} from "./fabric-ai-tools";
// Default-MCP config lookup (managed-default surface routing helper).
// `findExcalidrawConfigActivity` is the legacy alias kept registered so
// pre-rename workflow histories continue to replay deterministically.
export {
	type FindDefaultMcpConfigArgs,
	type FindDefaultMcpConfigResult,
	findDefaultMcpConfigActivity,
	findExcalidrawConfigActivity,
} from "./find-default-mcp-config";
// Default-enabled MCP server registry — drives keyword-based eager routing
export {
	type DefaultEnabledMcpServerEntry,
	listDefaultEnabledMcpServersActivity,
} from "./list-default-enabled-mcp-servers";
export { searchAvailableAgents } from "./search-agents";
export {
	getIntegrationProviderMetadata,
	INTEGRATION_PROVIDER_METADATA,
	searchAvailableIntegrations,
} from "./search-integrations";
// Search Functions
export {
	detectExplicitServerMention,
	ensureToolIndexBuilt,
	fetchToolsFromServerIds,
	getAvailableServerNames,
	loadToolDefinitions,
	preloadMcpToolsForConfigsActivity,
	rebuildToolIndex,
	searchAvailableTools,
} from "./search-tools";

export { searchAvailableWorkflows } from "./search-workflows";
// Tool Definitions (LLM schemas)
export {
	agentSearchToolDefinition,
	getAllOrchestratorToolDefinitions,
	getOrchestratorToolDefinitions,
	integrationSearchToolDefinition,
	toolSearchToolDefinition,
	workflowSearchToolDefinition,
} from "./tool-definitions";
// Tool Index
export {
	type BuildIndexOptions,
	type ToolCategory,
	ToolIndex,
	type ToolIndexEntry,
	type ToolSearchOptions,
	type ToolSearchResult,
	toolIndex,
} from "./tool-index";
// Types
export type {
	IntegrationProviderMetadata,
	SearchAvailableAgentsInput,
	SearchAvailableAgentsOutput,
	SearchAvailableIntegrationsInput,
	SearchAvailableIntegrationsOutput,
	SearchAvailableToolsInput,
	SearchAvailableToolsOutput,
	SearchAvailableWorkflowsInput,
	SearchAvailableWorkflowsOutput,
} from "./types";
// Utilities (extractQueryWords is local, cosineSimilarity/hybridScore from capability-embeddings)
export { extractQueryWords } from "./utils";
