/**
 * Analyze Task Node
 *
 * Loads available tools and analyzes the user's request to select the appropriate tool.
 * Supports multi-tenant model configuration when API key is provided.
 * Enhanced with Fabric AI prompt composition for better results.
 */

import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import type { RunnableConfig } from "@langchain/core/runnables";
import { Command, END } from "@langchain/langgraph";
import {
	detectAndCompose,
	logAgentUsageFromRunnableConfig,
} from "@repo/agent-core";
import {
	getAnalyzeTaskSystemPrompt,
	getAnalyzeTaskUserPrompt,
} from "../prompts";
import type { ApiAgentStateType } from "../state";
import type { ApiAgentStage, OpenAPIToolDescriptor } from "../types";
import {
	extractTask,
	formatToolSummary,
	getAgentModel,
	loadOpenAPITools,
} from "../utils";

/**
 * Analyze task node
 *
 * Loads OpenAPI tools and uses LLM to select the best tool for the user's request.
 *
 * @param state - Current agent state
 * @param config - Runnable configuration
 * @returns Command to update state and route to next node
 */
export async function analyzeTaskNode(
	state: ApiAgentStateType,
	config?: RunnableConfig,
): Promise<Command> {
	let fabricApiUrl = state.fabricApiUrl;
	let userId = state.userId;
	let organizationId = state.organizationId;
	let availableTools = state.availableTools || [];

	// Extract configuration from runtime config
	if (config?.configurable) {
		const configurable = config.configurable as Record<string, unknown>;
		if (configurable.fabric_api_url) {
			fabricApiUrl = String(configurable.fabric_api_url);
		}
		if (configurable.user_id) {
			userId = String(configurable.user_id);
		}
		if (configurable.organization_id) {
			organizationId = String(configurable.organization_id);
		}
		// Accept pre-loaded tools from A2A context
		if (configurable.openapi_tools && !availableTools.length) {
			try {
				const toolsData =
					typeof configurable.openapi_tools === "string"
						? JSON.parse(configurable.openapi_tools)
						: configurable.openapi_tools;
				if (Array.isArray(toolsData)) {
					availableTools = toolsData as OpenAPIToolDescriptor[];
				}
			} catch {
				// Ignore parsing errors
			}
		}
	}

	// Load tools from Fabric API if not already provided
	if (!availableTools.length && fabricApiUrl) {
		console.log("[API Agent] Loading OpenAPI tools from Fabric...");
		availableTools = await loadOpenAPITools(
			fabricApiUrl,
			userId,
			organizationId,
		);
		console.log(
			`[API Agent] Loaded ${availableTools.length} OpenAPI tools`,
		);
	}

	const task = extractTask(state);
	if (!task) {
		return new Command({
			goto: END,
			update: {
				stage: "error" as ApiAgentStage,
				error: "I couldn't determine what API task to perform. Please describe the API request you need.",
			},
		});
	}

	if (!availableTools.length) {
		return new Command({
			goto: END,
			update: {
				stage: "error" as ApiAgentStage,
				error: "No OpenAPI services are configured. Please add OpenAPI services in Settings > OpenAPI Services to enable external API calls.",
				response:
					"No OpenAPI services are configured. Please add OpenAPI services in Settings > OpenAPI Services to enable external API calls.",
			},
		});
	}

	// Use LLM to select the best tool and extract parameters
	try {
		// The shared factory routes every provider (incl. Databricks) through
		// createProviderModel; credentials arrive via config.configurable.
		const model = await getAgentModel(config, {
			temperature: 0.2,
			maxTokens: 4000,
		});

		const toolSummary = formatToolSummary(availableTools, 30);
		let systemPrompt = getAnalyzeTaskSystemPrompt(toolSummary);
		const userPrompt = getAnalyzeTaskUserPrompt(task, state.context);

		// Apply Fabric AI prompt enhancement
		try {
			const fabricResult = await detectAndCompose({
				userMessage: task,
				basePrompt: systemPrompt,
			});

			if (
				fabricResult.fabricAvailable &&
				(fabricResult.components.pattern ||
					fabricResult.components.context ||
					fabricResult.components.strategy)
			) {
				systemPrompt = fabricResult.prompt;
				console.log("[API Agent] Fabric AI enhancement applied:", {
					pattern: fabricResult.components.pattern,
					context: fabricResult.components.context,
					strategy: fabricResult.components.strategy,
				});
			}
		} catch (error) {
			console.warn(
				"[API Agent] Fabric AI enhancement failed, using base prompt:",
				error,
			);
		}

		const generationStart = Date.now();
		const response = await model.invoke([
			new SystemMessage(systemPrompt),
			new HumanMessage(userPrompt),
		]);

		await logAgentUsageFromRunnableConfig(config, response, {
			taskType: "TOOL_CALLING",
			agentId: "api_agent",
			latencyMs: Date.now() - generationStart,
		});

		const content = response.content?.toString() || "{}";
		const jsonMatch = content.match(/\{[\s\S]*\}/);
		const parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : {};

		const selectedIndex = parsed.selectedToolIndex || 0;

		if (selectedIndex === 0 || selectedIndex > availableTools.length) {
			return new Command({
				goto: END,
				update: {
					stage: "complete" as ApiAgentStage,
					fabricApiUrl,
					userId,
					organizationId,
					availableTools,
					taskDescription: task,
					response: `I couldn't find a suitable API for your request: "${task}". ${parsed.reasoning || "Please try a different request or add more OpenAPI services."}`,
				},
			});
		}

		const selectedTool = availableTools[selectedIndex - 1];
		const parameters = parsed.parameters || {};

		console.log(
			`[API Agent] Selected tool: ${selectedTool.name} from ${selectedTool.serviceName}`,
		);

		return new Command({
			goto: "execute_tool",
			update: {
				stage: "executing" as ApiAgentStage,
				fabricApiUrl,
				userId,
				organizationId,
				availableTools,
				taskDescription: task,
				selectedTool,
				toolArguments: parameters,
				error: undefined,
			},
		});
	} catch (error) {
		console.error("[API Agent] Error analyzing task:", error);
		return new Command({
			goto: END,
			update: {
				stage: "error" as ApiAgentStage,
				error:
					error instanceof Error
						? error.message
						: "Unknown error while analyzing API task",
			},
		});
	}
}
