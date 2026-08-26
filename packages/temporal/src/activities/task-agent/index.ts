/**
 * Task Agent Activities
 *
 * Activities for the TaskAgentWorkflow - handles plan management,
 * agent execution, and MCP tool calls.
 *
 * This module is split into focused files for maintainability:
 * - types.ts - Type definitions
 * - plan-management.ts - Plan CRUD operations
 * - agent-execution.ts - LLM execution
 * - mcp-tools.ts - MCP tool execution (Sandbox, GitHub)
 * - rag-context.ts - RAG context retrieval
 * - approval.ts - Approval validation
 * - broadcast.ts - Progress broadcasting
 */

// =============================================================================
// Type Exports
// =============================================================================

export type {
	AddWorkflowLogInput,
	AgentMessage,
	BroadcastProgressInput,
	ExecuteAgentTurnInput,
	ExecuteAgentTurnOutput,
	ExecuteMcpToolInput,
	InitializeWorkflowPlanInput,
	LoadMcpConfigurationInput,
	MCPConfiguration,
	RetrieveProjectContextsInput,
	UpdateWorkflowPlanInput,
	ValidateApprovalFieldsInput,
	ValidateApprovalFieldsResult,
} from "./types";

// =============================================================================
// Plan Management Activities
// =============================================================================

export {
	addWorkflowLog,
	initializeWorkflowPlan,
	updateWorkflowPlan,
} from "./plan-management";

// =============================================================================
// RAG Context Retrieval
// =============================================================================

export {
	formatLiveUrlSourcesForPrompt,
	type GatherLiveUrlSourcesInput,
	gatherLiveUrlSources,
	type LiveUrlContent,
	type LiveUrlContentMode,
	retrieveProjectContexts,
} from "./rag-context";

// =============================================================================
// Approval Validation
// =============================================================================

export { validateApprovalFields } from "./approval";

// =============================================================================
// Agent Execution Activities
// =============================================================================

export { executeAgentTurn } from "./agent-execution";

// =============================================================================
// MCP Tool Execution
// =============================================================================

export { executeTaskAgentTool, loadMcpConfiguration } from "./mcp-tools";

// =============================================================================
// Progress Broadcasting
// =============================================================================

export { broadcastProgress } from "./broadcast";
