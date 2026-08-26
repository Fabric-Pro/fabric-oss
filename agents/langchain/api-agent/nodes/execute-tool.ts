/**
 * Execute Tool Node
 *
 * Executes the selected OpenAPI tool with the provided arguments.
 */

import type { RunnableConfig } from "@langchain/core/runnables";
import { Command, END } from "@langchain/langgraph";
import type { ApiAgentStateType } from "../state";
import type { ApiAgentStage } from "../types";
import { executeOpenAPITool } from "../utils";

/**
 * Execute tool node
 *
 * Executes the selected OpenAPI tool via Fabric API.
 *
 * @param state - Current agent state
 * @param _config - Runnable configuration (unused)
 * @returns Command to update state and route to next node
 */
export async function executeToolNode(
	state: ApiAgentStateType,
	_config?: RunnableConfig,
): Promise<Command> {
	const { selectedTool, toolArguments, fabricApiUrl } = state;

	if (!selectedTool) {
		return new Command({
			goto: END,
			update: {
				stage: "error" as ApiAgentStage,
				error: "No tool was selected for execution.",
			},
		});
	}

	if (!fabricApiUrl) {
		return new Command({
			goto: END,
			update: {
				stage: "error" as ApiAgentStage,
				error: "Fabric API URL is not configured. This agent must be called from within Fabric.",
			},
		});
	}

	console.log(`[API Agent] Executing tool: ${selectedTool.name}`, {
		toolId: selectedTool.id,
		arguments: toolArguments,
	});

	const result = await executeOpenAPITool(
		fabricApiUrl,
		selectedTool.id,
		toolArguments || {},
	);

	console.log("[API Agent] Tool execution result:", {
		success: result.success,
		statusCode: result.statusCode,
		responseTime: result.responseTime,
	});

	return new Command({
		goto: "format_response",
		update: {
			stage: "formatting" as ApiAgentStage,
			executionResult: result,
			error: result.success ? undefined : result.error,
		},
	});
}
