/**
 * @repo/letta
 *
 * Letta integration for semantic memory and stateful agents
 * @see https://docs.letta.com
 *
 * Features:
 * - Persistent agent memory across sessions
 * - Tool result caching to eliminate duplicate API calls
 * - Shared memory blocks for organization-wide context
 * - Multi-agent communication and coordination
 */

// Agents
export {
	cacheToolResult,
	createOrchestratorAgent,
	createToolExecutorAgent,
	getCachedToolResult,
	getOrCreateOrchestratorAgent,
	getOrCreateToolExecutorAgent,
	getRoutingSuggestions,
	recordExecution,
	recordToolPattern,
} from "./agents";
export type { CreateOrchestratorOptions } from "./agents/orchestrator";
export type { CreateToolExecutorOptions } from "./agents/tool-executor";
// Client
export { getLettaClient, LettaClient, LettaError } from "./client";
// Memory
export {
	createSharedBlockConfig,
	SHARED_BLOCK_TEMPLATES,
	SharedMemoryManager,
} from "./memory";
export type {
	OrganizationContext,
	ProjectContext,
} from "./memory/shared-blocks";
// Types
export type {
	AgentMemoryState,
	ArchivalMemoryEntry,
	ArchivalSearchResult,
	FabricAgentType,
	LettaAgent,
	LettaAgentConfig,
	LettaClientOptions,
	LettaHealthStatus,
	LettaMessage,
	LettaMessageResponse,
	LettaTool,
	LettaToolCall,
	MemoryBlock,
	SharedMemoryConfig,
	ToolResultCache,
} from "./types";
