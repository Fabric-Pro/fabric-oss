/**
 * Format Response Node
 *
 * Formats the API response in a user-friendly way.
 * Supports multi-tenant model configuration when API key is provided.
 */

import {
	AIMessage,
	HumanMessage,
	SystemMessage,
} from "@langchain/core/messages";
import type { RunnableConfig } from "@langchain/core/runnables";
import { Command, END } from "@langchain/langgraph";
import { logAgentUsageFromRunnableConfig } from "@repo/agent-core";
import {
	getFormatResponseSystemPrompt,
	getFormatResponseUserPrompt,
} from "../prompts";
import type { ApiAgentStateType } from "../state";
import type { ApiAgentStage } from "../types";
import { getAgentModel } from "../utils";

/**
 * Format response node
 *
 * Uses LLM to format the API response in a user-friendly way.
 *
 * @param state - Current agent state
 * @param config - Runnable configuration
 * @returns Command to update state and route to END
 */
export async function formatResponseNode(
	state: ApiAgentStateType,
	config?: RunnableConfig,
): Promise<Command> {
	const { selectedTool, executionResult, taskDescription } = state;

	if (!executionResult) {
		return new Command({
			goto: END,
			update: {
				stage: "error" as ApiAgentStage,
				error: "No execution result available.",
			},
		});
	}

	if (!executionResult.success) {
		return new Command({
			goto: END,
			update: {
				stage: "error" as ApiAgentStage,
				response: `The API call to ${selectedTool?.name || "the tool"} failed: ${executionResult.error}`,
				error: executionResult.error,
			},
		});
	}

	// Use LLM to format the response nicely
	try {
		// Resolve the tenant's configured model from the RunnableConfig.
		const model = await getAgentModel(config, {
			temperature: 0.3,
			maxTokens: 4000,
		});

		const systemPrompt = getFormatResponseSystemPrompt();
		const userPrompt = getFormatResponseUserPrompt(
			taskDescription || "Unknown request",
			selectedTool?.name || "Unknown tool",
			selectedTool?.serviceName || "Unknown service",
			executionResult.data,
		);

		const generationStart = Date.now();
		const response = await model.invoke([
			new SystemMessage(systemPrompt),
			new HumanMessage(userPrompt),
		]);

		await logAgentUsageFromRunnableConfig(config, response, {
			taskType: "COMPLEX",
			agentId: "api_agent",
			latencyMs: Date.now() - generationStart,
		});

		const formattedResponse =
			response.content?.toString() || "API call completed successfully.";

		return new Command({
			goto: END,
			update: {
				stage: "complete" as ApiAgentStage,
				response: formattedResponse,
				messages: [
					...(state.messages || []),
					new AIMessage(formattedResponse),
				],
			},
		});
	} catch {
		// Fallback to raw response if formatting fails
		const rawResponse = `API call to ${selectedTool?.name} completed successfully.\n\nResponse:\n${JSON.stringify(executionResult.data, null, 2)}`;

		return new Command({
			goto: END,
			update: {
				stage: "complete" as ApiAgentStage,
				response: rawResponse,
				messages: [
					...(state.messages || []),
					new AIMessage(rawResponse),
				],
			},
		});
	}
}
