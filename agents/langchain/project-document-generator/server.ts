/**
 * LangGraph Server Entry Point for Project Document Generator Agent
 * This file is required by @langchain/langgraph-cli to run the agent as a server
 */

import { projectDocumentGeneratorGraph } from "./agent.js";

/**
 * Export the graph for LangGraph CLI
 * The graph is already compiled in agent.ts
 */
export const graph = projectDocumentGeneratorGraph;

/**
 * Export graph metadata for LangGraph CLI
 */
export const graphMetadata = {
	name: "project_document_generator",
	description:
		"Project document generator with RAG context and predictive state updates for real-time streaming",
	version: "1.0.0",
	capabilities: [
		"project-document-generation",
		"rag-integration",
		"predictive-updates",
		"diff-highlighting",
	],
	supportsPredictiveUpdates: true,
};
