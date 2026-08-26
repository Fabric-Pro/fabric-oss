/**
 * Backend Services for @repo/agent-core
 *
 * These services depend on @repo/database and other backend packages.
 * They are exported separately to avoid ESM compatibility issues with
 * agents that run as separate Node.js processes (like CUGA).
 *
 * Usage in backend contexts (API routes, Temporal activities):
 *   import { getConfiguredAIModel, getMcpClient } from "@repo/agent-core/backend"
 *
 * DO NOT import these in ESM-only contexts like standalone agents.
 */

// AI Provider utilities
export {
	type AIProviderConfig,
	getConfiguredAIModel,
	isAIProviderConfigured,
	type ResolvedAIConfig,
	resolveAIProviderApiKey,
} from "./services/ai-gateway";

// MCP Tools utilities
export {
	canMcpToolsHandleTask,
	closeMcpClientSafe,
	type DetailedMcpToolInfo,
	type GetMcpToolsOptions,
	getDefaultEnabledMcpConfigIds,
	getDetailedMcpToolInfo,
	getMcpClient,
	getMcpClientResult,
	getTenantMcpConfigs,
	type McpClientResult,
	type McpClientResultOrError,
	type McpToolMatchResult,
	seedDefaultMcpConfigsForTenant,
} from "./services/mcp-tools";

// Semantic Memory utilities
export {
	generateMemoryContext,
	type MemoryContext,
	type SemanticMemoryResult,
	type SemanticSearchOptions,
	searchSemanticMemory,
} from "./services/semantic-memory";
