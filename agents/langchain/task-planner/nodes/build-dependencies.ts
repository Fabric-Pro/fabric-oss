/**
 * Build Dependencies Node
 *
 * Builds a dependency graph from the decomposed tasks.
 */

import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import type { RunnableConfig } from "@langchain/core/runnables";
import { Command } from "@langchain/langgraph";
import { getDependencyAnalysisPrompt } from "../prompts";
import type { TaskPlannerStateType } from "../state";
import type { DependencyGraph } from "../types";
import { getAgentModelSync, type ProviderConfig, withRetry } from "../utils";

/**
 * Build Dependencies Node
 *
 * Stage 3: Creates a dependency graph showing task relationships and critical path.
 */
export async function buildDependenciesNode(
	state: TaskPlannerStateType,
	config?: RunnableConfig,
): Promise<Command> {
	console.log("[Task Planner] Stage 3: Building dependency graph");

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

		const model = getAgentModelSync(providerConfig, { temperature: 0.1 });
		console.log(
			"[Task Planner] Using model:",
			providerConfig?.model || "groq/llama-3.3-70b-versatile (env)",
		);
		const systemPrompt = getDependencyAnalysisPrompt();

		const userMessage = `Build a dependency graph for these tasks:

${JSON.stringify(state.decomposedTasks, null, 2)}

Return a JSON object with "dependencyGraph" containing nodes, edges, and criticalPath.`;

		const response = await withRetry(async () => {
			return model.invoke([
				new SystemMessage(systemPrompt),
				new HumanMessage(userMessage),
			]);
		});

		const content = response.content?.toString() || "{}";
		const jsonMatch = content.match(/\{[\s\S]*\}/);
		const parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : {};

		const dependencyGraph: DependencyGraph = parsed.dependencyGraph || {
			nodes: state.decomposedTasks.map((t) => ({
				id: t.id,
				label: t.title,
				level: 0,
				type: t.type,
			})),
			edges: [],
			criticalPath: [],
			totalCriticalPathDuration: 0,
		};

		console.log(
			"[Task Planner] Critical path:",
			dependencyGraph.criticalPath.length,
			"tasks",
		);

		return new Command({
			goto: "plan_execution",
			update: {
				dependencyGraph,
				currentStage: "Planning execution...",
			},
		});
	} catch (error) {
		console.error("[Task Planner] Dependency analysis failed:", error);
		return new Command({
			goto: "plan_execution",
			update: {
				dependencyGraph: {
					nodes: [],
					edges: [],
					criticalPath: [],
					totalCriticalPathDuration: 0,
				},
			},
		});
	}
}
