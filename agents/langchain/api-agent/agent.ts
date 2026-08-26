/**
 * API Agent with AG-UI and A2A Protocol Support
 *
 * LangGraph agent that executes OpenAPI tools registered in Fabric.
 * Analyzes user requests, selects appropriate OpenAPI tools, and executes them.
 *
 * Features:
 * - OpenAPI tool discovery and execution
 * - Multi-tenancy support (user/organization context)
 * - AG-UI protocol for CopilotKit integration
 * - A2A protocol for inter-agent communication
 *
 * Architecture:
 * - state/       - LangGraph state annotations
 * - prompts/     - System prompts for each phase
 * - nodes/       - LangGraph node functions
 * - utils/       - Helper utilities
 * - types.ts     - Type definitions
 *
 * @module api-agent
 */

import { START, StateGraph } from "@langchain/langgraph";

// State
import { ApiAgentState } from "./state";

// Nodes
import { analyzeTaskNode, executeToolNode, formatResponseNode } from "./nodes";

// Types
export * from "./types";

// ============================================================================
// Graph Definition
// ============================================================================

/**
 * Create the API agent workflow graph
 *
 * The graph implements the following pipeline:
 *
 * START
 *   └─> analyze_task
 *        ├─> execute_tool
 *        │     └─> format_response
 *        │           └─> END
 *        └─> END (if no suitable tool found)
 */
const workflow = new StateGraph(ApiAgentState);

// Add nodes with Command-based routing
// When using Command objects for dynamic routing, we must declare potential destinations via "ends"
workflow.addNode("analyze_task", analyzeTaskNode, {
	ends: ["execute_tool", "__end__"],
});
workflow.addNode("execute_tool", executeToolNode, {
	ends: ["format_response", "__end__"],
});
workflow.addNode("format_response", formatResponseNode, {
	ends: ["__end__"],
});

// Entry point
workflow.addEdge(START, "analyze_task" as typeof START);

// Compile the graph
export const apiAgentGraph = workflow.compile();

// ============================================================================
// Graph Metadata for LangGraph CLI
// ============================================================================

/**
 * Graph metadata for LangGraph discovery and CLI tools
 */
export const graphMetadata = {
	name: "api_agent",
	description:
		"API Agent that executes OpenAPI tools registered in Fabric. Use this agent to make external API calls to services configured in OpenAPI Services settings.",
	version: "1.1.0",
	capabilities: [
		"openapi",
		"api-execution",
		"external-apis",
		"ag-ui-protocol",
		"a2a-protocol",
	],
	protocols: ["a2a", "ag-ui"],
	supportsPredictiveUpdates: false,
};

// ============================================================================
// Exports for Testing
// ============================================================================

export { ApiAgentState };

// Re-export nodes for testing
export {
	analyzeTaskNode,
	executeToolNode,
	formatResponseNode,
} from "./nodes";

// Re-export prompts for customization
export {
	getAnalyzeTaskSystemPrompt,
	getAnalyzeTaskUserPrompt,
	getFormatResponseSystemPrompt,
	getFormatResponseUserPrompt,
} from "./prompts";
// Re-export utilities for external use
export {
	executeOpenAPITool,
	extractTask,
	formatToolSummary,
	getAgentModel,
	loadOpenAPITools,
} from "./utils";
