/**
 * Story Breakdown Agent with AG-UI Protocol Support
 *
 * LangGraph agent for breaking down PRDs into actionable features.
 * Provides real-time streaming updates via predictive state updates (AG-UI protocol).
 *
 * Features:
 * - PRD analysis and decomposition
 * - INVEST criteria compliance
 * - Fibonacci story point estimation
 * - Real-time streaming via AG-UI protocol
 * - Support for custom prompts from Prompt Library
 *
 * Architecture:
 * - state/       - LangGraph state annotations
 * - prompts/     - System prompt generation
 * - nodes/       - LangGraph node functions
 * - utils/       - Helper utilities and constants
 *
 * @module story-breakdown
 */

import { END, START, StateGraph } from "@langchain/langgraph";

// State
import { StoryBreakdownState } from "./state";

// Nodes
import { breakdownNode } from "./nodes";

// ============================================================================
// Graph Definition
// ============================================================================

/**
 * Create the story breakdown workflow graph
 *
 * The graph implements a simple single-node pipeline:
 *
 * START
 *   └─> breakdown
 *        └─> END (or retry on error)
 */
const workflow = new StateGraph(StoryBreakdownState);

// Add node
workflow.addNode("breakdown", breakdownNode);

// Add edges
workflow.addEdge(START, "breakdown" as typeof START);
workflow.addEdge("breakdown" as typeof START, END);

// Compile the graph
export const storyBreakdownGraph = workflow.compile();

// ============================================================================
// Graph Metadata for LangGraph CLI
// ============================================================================

/**
 * Graph metadata for LangGraph discovery and CLI tools
 */
export const graphMetadata = {
	name: "story_breakdown",
	description:
		"AI-powered story breakdown that converts PRDs into actionable features",
	version: "1.1.0",
	capabilities: [
		"story-breakdown",
		"user-stories",
		"agile",
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

export { StoryBreakdownState };

// Re-export nodes for testing
export { breakdownNode } from "./nodes";

// Re-export prompts for customization
export {
	buildUserMessage,
	getDefaultSystemPrompt,
	getPredictStateConfig,
} from "./prompts";
// Re-export utilities for external use
export {
	calculateRetryDelay,
	createModel,
	DEFAULT_RECURSION_LIMIT,
	isJsonParseError,
	isRetryableError,
	MAX_RETRIES,
	RETRY_DELAY_MS,
	sleep,
} from "./utils";
