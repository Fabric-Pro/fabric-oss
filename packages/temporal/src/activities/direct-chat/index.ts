/**
 * Direct Chat Activities
 *
 * Modular activities for the direct chat workflow.
 * Split from the monolithic direct-chat-activities.ts for better maintainability.
 */

// Re-export workflow types for convenience
export type {
	DirectChatToolCall,
	DirectChatWorkflowInput,
	DirectChatWorkflowOutput,
} from "../../types";
// AI Execution
export { executeDirectChatActivity } from "./ai-execution";
// MCP Tools
export {
	closeMcpClients,
	collectMcpToolsActivity,
	getMcpClientsForExecution,
	type McpToolInfo,
} from "./mcp-tools";
// Memory Context
export { generateMemoryContextActivity } from "./memory-context";
// RAG Retrieval
export {
	type RagSource,
	retrieveRagContextForDirectChatActivity,
	retrieveWorkspaceDocumentsActivity,
} from "./rag-retrieval";
// Tool Suggestions
export {
	generateToolSuggestionsActivity,
	type ToolInfo,
} from "./tool-suggestions";
