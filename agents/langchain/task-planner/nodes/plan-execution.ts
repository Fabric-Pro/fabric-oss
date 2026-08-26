/**
 * Plan Execution Node
 *
 * Creates a phased execution plan optimizing for parallelization.
 */

import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import type { RunnableConfig } from "@langchain/core/runnables";
import { Command } from "@langchain/langgraph";
import { getExecutionPlanPrompt } from "../prompts";
import type { TaskPlannerStateType } from "../state";
import type { ExecutionPlan } from "../types";
import { getAgentModelSync, type ProviderConfig, withRetry } from "../utils";

/**
 * Plan Execution Node
 *
 * Stage 4: Creates an execution plan with phases and parallelization.
 */
export async function planExecutionNode(
	state: TaskPlannerStateType,
	config?: RunnableConfig,
): Promise<Command> {
	console.log("[Task Planner] Stage 4: Planning execution");

	try {
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

		const model = getAgentModelSync(providerConfig, { temperature: 0.2 });
		console.log(
			"[Task Planner] Using model:",
			providerConfig?.model || "groq/llama-3.3-70b-versatile (env)",
		);
		const systemPrompt = getExecutionPlanPrompt();

		const userMessage = `Create an execution plan for these tasks:

Tasks: ${JSON.stringify(state.decomposedTasks, null, 2)}

Dependencies: ${JSON.stringify(state.dependencyGraph, null, 2)}

Return a JSON object with "executionPlan" containing phases, durations, and team size.`;

		const response = await withRetry(async () => {
			return model.invoke([
				new SystemMessage(systemPrompt),
				new HumanMessage(userMessage),
			]);
		});

		const content = response.content?.toString() || "{}";
		const jsonMatch = content.match(/\{[\s\S]*\}/);
		const parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : {};

		const totalEstimate = state.decomposedTasks.reduce(
			(sum, t) => sum + t.estimate,
			0,
		);
		const executionPlan: ExecutionPlan = parsed.executionPlan || {
			phases: [
				{
					id: "PHASE-1",
					name: "All Tasks",
					tasks: state.decomposedTasks.map((t) => t.id),
					duration: totalEstimate,
					dependencies: [],
				},
			],
			totalDuration: totalEstimate,
			parallelDuration: totalEstimate,
			parallelizationFactor: 0,
			recommendedTeamSize: 1,
		};

		console.log(
			"[Task Planner] Execution plan:",
			executionPlan.phases.length,
			"phases",
		);

		return new Command({
			goto: "generate_document",
			update: {
				executionPlan,
				currentStage: "Generating document...",
			},
		});
	} catch (error) {
		console.error("[Task Planner] Execution planning failed:", error);
		return new Command({
			goto: "generate_document",
			update: {
				executionPlan: {
					phases: [],
					totalDuration: 0,
					parallelDuration: 0,
					parallelizationFactor: 0,
					recommendedTeamSize: 1,
				},
			},
		});
	}
}
