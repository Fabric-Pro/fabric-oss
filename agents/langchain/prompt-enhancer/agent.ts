/**
 * Prompt Enhancer Agent with AG-UI Protocol Support
 *
 * LangGraph agent for enhancing prompt content with AI assistance.
 * Provides real-time streaming updates via predictive state updates.
 *
 * Features:
 * - AI-powered prompt enhancement
 * - Template variable preservation
 * - Format-aware improvements
 * - Real-time streaming via AG-UI protocol
 *
 * Architecture:
 * - state/       - LangGraph state annotations
 * - prompts/     - System prompt generation
 * - nodes/       - LangGraph node functions
 * - utils/       - Helper utilities and constants
 * - types.ts     - Type definitions
 *
 * @module prompt-enhancer
 */

import { START, StateGraph } from "@langchain/langgraph";

// State
import { PromptEnhancerState } from "./state";

// Nodes
import { enhanceNode } from "./nodes";

// Types
export * from "./types.js";

// ============================================================================
// Graph Definition
// ============================================================================

/**
 * Create the prompt enhancer workflow graph
 *
 * The graph implements a simple single-node pipeline:
 *
 * START
 *   └─> enhance
 *        └─> END
 */
const workflow = new StateGraph(PromptEnhancerState)
	.addNode("enhance", enhanceNode)
	.addEdge(START, "enhance");

// Compile the graph
export const promptEnhancerGraph = workflow.compile({
	checkpointer: false, // No checkpointing needed for simple enhancement
});

// ============================================================================
// Graph Metadata for LangGraph CLI
// ============================================================================

/**
 * Graph metadata for LangGraph discovery and CLI tools
 */
export const graphMetadata = {
	name: "prompt_enhancer",
	description:
		"AI-powered prompt enhancement with real-time streaming and format-aware improvements",
	version: "1.1.0",
	capabilities: [
		"prompt-enhancement",
		"format-aware",
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

export { PromptEnhancerState };

// Re-export nodes for testing
export { enhanceNode } from "./nodes";

// Re-export prompts for customization
export { getPredictStateConfig, getSystemPrompt } from "./prompts";
// Re-export utilities for external use
export {
	DEFAULT_RECURSION_LIMIT,
	extractProviderConfig,
	getAgentModel,
	getAgentModelAsync,
} from "./utils";
