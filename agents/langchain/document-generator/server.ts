/**
 * LangGraph Server Entry Point for Document Generator Agent
 * This file is required by @langchain/langgraph-cli to run the agent as a server
 */

import { predictiveStateUpdatesGraph } from "./agent.js";

/**
 * Export the graph for LangGraph CLI
 * The graph is already compiled in agent.ts
 */
export const graph = predictiveStateUpdatesGraph;

/**
 * Export graph metadata for LangGraph CLI
 */
export const graphMetadata = {
	name: "document_generator",
	description:
		"Document generator with predictive state updates for real-time streaming",
	version: "1.0.0",
	capabilities: [
		"document-generation",
		"predictive-updates",
		"diff-highlighting",
	],
	supportsPredictiveUpdates: true,
};
