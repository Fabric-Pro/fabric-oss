/**
 * Step Execution Activity
 *
 * Executes individual steps in a task plan using capability-based routing.
 * Routes to agents, MCP tools, or LLM based on step configuration.
 *
 * This module has been refactored to use a modular handler system.
 * See ./handlers/ for capability-specific implementations:
 * - LlmHandler: Pure LLM generation without tools
 * - AgentHandler: Agent delegation via A2A protocol
 * - FabricAiHandler: Fabric AI tools (YouTube, scraping, patterns)
 * - McpToolHandler: MCP tool execution (default fallback)
 * - WorkflowHandler: Pre-defined Temporal workflows
 * - WebHandler: Web browsing/scraping capabilities
 */

import type { ExecuteStepInput, ExecuteStepOutput } from "../types";
import { publishStepStart } from "../utils/partykit-publisher";
import { getDefaultHandlerRegistry, type HandlerRegistry } from "./handlers";

// Singleton handler registry for performance
let handlerRegistry: HandlerRegistry | null = null;

function getHandlerRegistry(): HandlerRegistry {
	if (!handlerRegistry) {
		handlerRegistry = getDefaultHandlerRegistry();
	}
	return handlerRegistry;
}

/**
 * Executes a single step in the task plan.
 *
 * Supports capability-based routing:
 * - `agent`: Delegates to a specialized agent via A2A
 * - `mcp_tool`: Executes MCP tools directly
 * - `llm`: Uses LLM for text generation without tools
 * - `web`: Routes to browser-capable agents or web scraping tools
 * - `workflow`: Executes pre-defined workflows
 * - `fabric_ai`: Executes Fabric AI tools (YouTube, scraping, patterns)
 *
 * Implementation uses a modular handler system in ./handlers/
 */
export async function executeStep(
	input: ExecuteStepInput,
): Promise<ExecuteStepOutput> {
	console.log(
		`[Orchestrator] Executing step: ${input.step.id} - ${input.step.description}`,
	);

	const capability = input.step.capability || "mcp_tool";
	const executor = input.step.executor;
	const app = input.step.app;

	console.log(
		`[Orchestrator] Step capability: ${capability}, app: ${app || "none"}, executor: ${executor || "none"}`,
	);

	// Publish step start to PartyKit immediately for real-time UI updates
	// This eliminates the gap between planning and execution in the UI
	if (input.executionId) {
		publishStepStart(
			input.executionId,
			input.step.id,
			input.step.description,
			input.stepIndex,
			input.totalSteps,
		).catch(() => {}); // Non-blocking
	}

	// Delegate to handler registry for modular execution
	const registry = getHandlerRegistry();
	return registry.executeStep(input);
}

// Re-export handler types for external use
export type {
	HandlerContext,
	HandlerResult,
	StepHandler,
	ToolCallRecord,
} from "./handlers";
