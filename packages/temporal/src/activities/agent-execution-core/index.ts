/**
 * Agent Execution Core Module
 *
 * Shared utilities for executing AI agents in Temporal workflows.
 * Provides modular, reusable components for:
 * - Knowledge source fetching (RAG)
 * - AI model execution with tool loops
 * - Context building
 *
 * Used by:
 * - Template Instance Execution
 * - Agent Deployment Execution
 * - Other agent-based workflows
 */

// Agent execution with tool loops
export {
	executeAgentTurn,
	loadMcpToolsForAgent,
	type PreviewAgentTurnInput,
	type PreviewAgentTurnResult,
	previewAgentTurn,
} from "./agent-executor";
// Context building utilities
export {
	buildAgentExecutionContext,
	buildSystemPrompt,
	buildUserInputContext,
	type ConnectionMappings,
	extractBuiltInToolNames,
	extractMcpConfigIds,
	type InstanceConfig,
	type TemplateConfig,
} from "./context-builder";
// Knowledge fetching (RAG)
export {
	buildKnowledgeContextPrompt,
	fetchKnowledgeSources,
} from "./knowledge-fetcher";
// Types
export * from "./types";
