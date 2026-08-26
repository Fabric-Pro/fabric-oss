/**
 * Document Generator Agent with AG-UI Protocol Support
 *
 * LangGraph agent for generating and editing documents with real-time streaming.
 *
 * Features:
 * - Real-time streaming of document generation
 * - Predictive state updates via AG-UI protocol
 * - Error handling and recovery with retry logic
 * - Support for custom prompts from Prompt Library
 *
 * Architecture:
 * - state/       - LangGraph state annotations
 * - prompts/     - System prompt generation
 * - nodes/       - LangGraph node functions
 * - utils/       - Helper utilities and constants
 *
 * @module document-generator
 */

import { END, START, StateGraph } from "@langchain/langgraph";

// State
import { AgentStateAnnotation } from "./state";

// Nodes
import { chatNode } from "./nodes";

// ============================================================================
// Graph Definition
// ============================================================================

/**
 * Create the document generator workflow graph
 *
 * The graph implements a simple single-node pipeline:
 *
 * START
 *   └─> chat_node
 *        └─> END (or retry on error)
 */
const workflow = new StateGraph(AgentStateAnnotation);

// Add node
workflow.addNode("chat_node", chatNode);

// Add edges
workflow.addEdge(START, "chat_node" as typeof START);
workflow.addEdge("chat_node" as typeof START, END);

// Compile the graph
export const predictiveStateUpdatesGraph = workflow.compile();

// ============================================================================
// Graph Metadata for LangGraph CLI
// ============================================================================

/**
 * Graph metadata for LangGraph discovery and CLI tools
 */
export const graphMetadata = {
	name: "document_generator",
	description:
		"AI-powered document generator with real-time streaming and predictive state updates",
	version: "1.1.0",
	capabilities: [
		"document-generation",
		"document-editing",
		"predictive-updates",
		"streaming",
		"ag-ui-protocol",
		"a2a-protocol",
	],
	protocols: ["a2a", "ag-ui"],
	supportsPredictiveUpdates: true,
};

// ============================================================================
// Exports for Testing
// ============================================================================

export { AgentStateAnnotation };

// Re-export nodes for testing
export { chatNode } from "./nodes";

// Re-export prompts for customization
export { buildSystemPrompt, getPredictStateConfig } from "./prompts";
// Re-export utilities for external use
export {
	calculateRetryDelay,
	DEFAULT_RECURSION_LIMIT,
	getAgentModel,
	isJsonParseError,
	isRetryableError,
	MAX_RETRIES,
	RETRY_DELAY_MS,
	sleep,
} from "./utils";
