/**
 * Task Planner Agent with AG-UI Protocol
 *
 * Enhanced LangGraph agent for breaking down features into granular development tasks.
 *
 * Features:
 * - Multi-node graph for task decomposition
 * - Risk analysis with severity scoring
 * - Dependency graph generation
 * - Execution plan with parallelization
 * - Real-time streaming via AG-UI protocol
 *
 * Architecture:
 * - state/       - LangGraph state annotations
 * - prompts/     - System prompts for each phase
 * - nodes/       - LangGraph node functions
 * - utils/       - Helper utilities
 * - types.ts     - Type definitions
 * - a2a-server.ts - A2A protocol server
 *
 * @module task-planner
 */

import { END, START, StateGraph } from "@langchain/langgraph";

// State
import { TaskPlannerState } from "./state";

// Nodes
import {
	analyzeNode,
	assessRisksNode,
	buildDependenciesNode,
	generateDocumentNode,
	planExecutionNode,
} from "./nodes";

// Types
export * from "./types";

// ============================================================================
// Graph Definition
// ============================================================================

/**
 * Create the task planner workflow graph
 *
 * The graph implements the following multi-stage pipeline:
 *
 * START
 *   └─> analyze
 *        └─> assess_risks
 *             └─> build_dependencies
 *                  └─> plan_execution
 *                       └─> generate_document
 *                            └─> END
 */
const workflow = new StateGraph(TaskPlannerState);

// Add nodes
workflow.addNode("analyze", analyzeNode);
workflow.addNode("assess_risks", assessRisksNode);
workflow.addNode("build_dependencies", buildDependenciesNode);
workflow.addNode("plan_execution", planExecutionNode);
workflow.addNode("generate_document", generateDocumentNode);

// Add edges - multi-stage pipeline
// Type assertions needed for LangGraph's strict typing
workflow.addEdge(START, "analyze" as typeof START);
workflow.addEdge("analyze" as typeof START, "assess_risks" as typeof START);
workflow.addEdge(
	"assess_risks" as typeof START,
	"build_dependencies" as typeof START,
);
workflow.addEdge(
	"build_dependencies" as typeof START,
	"plan_execution" as typeof START,
);
workflow.addEdge(
	"plan_execution" as typeof START,
	"generate_document" as typeof START,
);
workflow.addEdge("generate_document" as typeof START, END);

// Compile the graph
export const taskPlannerGraph = workflow.compile();

// ============================================================================
// Graph Metadata for LangGraph CLI
// ============================================================================

/**
 * Graph metadata for LangGraph discovery and CLI tools
 */
export const graphMetadata = {
	name: "task_planner",
	description:
		"AI-powered task planner with CUGA-inspired task decomposition, risk analysis, and execution planning",
	version: "2.0.0",
	capabilities: [
		"task-planning",
		"task-decomposition",
		"risk-analysis",
		"dependency-graph",
		"execution-planning",
		"development-tasks",
		"estimation",
		"predictive-updates",
		"streaming",
		"ag-ui-protocol",
	],
	protocols: ["a2a", "ag-ui"],
	supportsPredictiveUpdates: true,
};

// ============================================================================
// Exports for Testing
// ============================================================================

export { TaskPlannerState };
// Re-export nodes for testing
// Re-export prompts for customization
// Re-export utilities for external use
