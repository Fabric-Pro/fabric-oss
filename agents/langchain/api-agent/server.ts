/**
 * API Agent Server
 *
 * LangGraph server entrypoint for the API Agent.
 */

import { apiAgentGraph, graphMetadata } from "./agent.js";

// Export the graph for LangGraph CLI
export const graph = apiAgentGraph;
export const metadata = graphMetadata;

// Default export for compatibility
export default apiAgentGraph;
