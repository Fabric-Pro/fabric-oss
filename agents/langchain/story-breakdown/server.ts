/**
 * Story Breakdown Agent Server
 *
 * LangGraph server for the Story Breakdown agent.
 */

import { graphMetadata, storyBreakdownGraph } from "./agent.js";

// Export the graph for LangGraph CLI
export const graph = storyBreakdownGraph;
export const metadata = graphMetadata;

// Default export for compatibility
export default storyBreakdownGraph;
