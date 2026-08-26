/**
 * Task Planner Agent Server
 *
 * LangGraph server for the Task Planner agent.
 */

import { graphMetadata, taskPlannerGraph } from "./agent.js";

// Export the graph for LangGraph CLI
export const graph = taskPlannerGraph;
export const metadata = graphMetadata;

// Default export for compatibility
export default taskPlannerGraph;
