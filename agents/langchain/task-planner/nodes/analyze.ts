/**
 * Analyze Node
 *
 * Analyzes features and decomposes them into granular tasks.
 * Enhanced with Fabric AI prompt composition for better results.
 */

import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import type { RunnableConfig } from "@langchain/core/runnables";
import { Command, END } from "@langchain/langgraph";
import { detectAndCompose } from "@repo/agent-core";
import { getAnalyzeSystemPrompt } from "../prompts";
import type { TaskPlannerStateType } from "../state";
import { getAgentModelSync, type ProviderConfig, withRetry } from "../utils";

/**
 * Analyze Node
 *
 * Stage 1: Analyzes and decomposes features into granular tasks.
 */
export async function analyzeNode(
	state: TaskPlannerStateType,
	config?: RunnableConfig,
): Promise<Command> {
	console.log("[Task Planner] Stage 1: Analyzing and decomposing tasks");

	try {
		if (!state.userStory) {
			throw new Error("No feature provided");
		}

		// Extract provider config from runtime config
		let providerConfig: ProviderConfig | undefined;
		if (config?.configurable) {
			const configurable = config.configurable as Record<string, unknown>;
			if (configurable.ai_api_key && configurable.ai_model) {
				providerConfig = {
					apiKey: String(configurable.ai_api_key),
					model: String(configurable.ai_model),
					provider: configurable.ai_provider
						? String(configurable.ai_provider)
						: undefined,
					baseUrl: configurable.ai_gateway_url
						? String(configurable.ai_gateway_url)
						: undefined,
					// Canonical-derived reasoning signal (Bug #1942 review): gates
					// Databricks <think> stripping when the serving alias is opaque.
					isReasoningModel:
						typeof configurable.ai_is_reasoning === "boolean"
							? configurable.ai_is_reasoning
							: undefined,
				};
			}
		}

		const model = getAgentModelSync(providerConfig, { temperature: 0.3 });
		console.log(
			"[Task Planner] Using model:",
			providerConfig?.model || "groq/llama-3.3-70b-versatile (env)",
		);

		// Get base system prompt
		let systemPrompt =
			state.systemPrompt || getAnalyzeSystemPrompt(state.techStack);

		// Apply Fabric AI prompt enhancement
		// Auto-detects patterns like "agility_story" for feature breakdowns
		try {
			const fabricResult = await detectAndCompose({
				userMessage: state.userStory,
				basePrompt: systemPrompt,
			});

			if (
				fabricResult.fabricAvailable &&
				(fabricResult.components.pattern ||
					fabricResult.components.context ||
					fabricResult.components.strategy)
			) {
				systemPrompt = fabricResult.prompt;
				console.log("[Task Planner] Fabric AI enhancement applied:", {
					pattern: fabricResult.components.pattern,
					context: fabricResult.components.context,
					strategy: fabricResult.components.strategy,
				});
			}
		} catch (error) {
			console.warn(
				"[Task Planner] Fabric AI enhancement failed, using base prompt:",
				error,
			);
		}

		const userMessage = `Analyze and decompose these features into granular tasks:

**Project:** ${state.projectName}
${state.projectDescription ? `**Description:** ${state.projectDescription}` : ""}
${state.techStack ? `**Tech Stack:** ${state.techStack}` : ""}

**Features:**
${state.userStory}

Return a JSON object with "decomposedTasks" array.`;

		const response = await withRetry(async () => {
			return model.invoke([
				new SystemMessage(systemPrompt),
				...state.messages,
				new HumanMessage(userMessage),
			]);
		});

		// Parse the JSON response
		const content = response.content?.toString() || "{}";
		const jsonMatch = content.match(/\{[\s\S]*\}/);
		const parsed = jsonMatch
			? JSON.parse(jsonMatch[0])
			: { decomposedTasks: [] };

		console.log(
			"[Task Planner] Decomposed into",
			parsed.decomposedTasks?.length || 0,
			"tasks",
		);

		return new Command({
			goto: "assess_risks",
			update: {
				decomposedTasks: parsed.decomposedTasks || [],
				currentStage: "Analyzing risks...",
				messages: [...state.messages, response],
			},
		});
	} catch (error) {
		console.error("[Task Planner] Analysis failed:", error);
		return new Command({
			goto: END,
			update: {
				error:
					error instanceof Error ? error.message : "Analysis failed",
			},
		});
	}
}
