/**
 * Model Factory Utility
 *
 * Resolves the LLM instance for the API Agent.
 *
 * Delegates to the shared `@repo/agent-core` factory (`getAgentModelAsync` →
 * `createProviderModel`) — the same path every other Fabric LangGraph agent
 * uses. That path resolves the tenant's configured provider from the LangGraph
 * `RunnableConfig.configurable` (`ai_provider`, `ai_api_key`, `ai_model`,
 * `ai_gateway_url`, `ai_deployment_name`, `tenant_user_id`,
 * `tenant_organization_id`) and routes ALL providers — including Databricks
 * (Unity AI Gateway), Azure AI Foundry, OpenAI-compatible gateways, and
 * reasoning models — through a single, well-tested factory.
 *
 * This replaces the old divergent `apiKey → resolveModelConfig →
 * createModelFromConfig` path, which had no Databricks branch and silently
 * fell through to Groq (issue #1938). Credentials now arrive via `configurable`
 * (populated by the unified/A2A server), matching the canonical agent contract.
 */

import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { RunnableConfig } from "@langchain/core/runnables";
import { getAgentModelAsync } from "@repo/agent-core";

/**
 * Model creation options
 */
export interface ModelOptions {
	/** Temperature for LLM responses (default: 0.2) */
	temperature?: number;
	/** Max tokens for response (default: 4000) */
	maxTokens?: number;
	/** Retry count for progressive temperature reduction */
	retryCount?: number;
}

/**
 * Get a model for agent execution.
 *
 * This is the primary entry point for getting a model in api-agent nodes.
 * Pass the node's `RunnableConfig`; tenant + provider selection is resolved
 * from `config.configurable` by the shared agent-core factory.
 *
 * @param config - RunnableConfig from LangGraph (carries tenant + AI provider config)
 * @param options - Model creation options
 * @returns Model instance
 * @throws Error if no provider configuration is available
 */
export async function getAgentModel(
	config?: RunnableConfig | null,
	options: ModelOptions = {},
): Promise<BaseChatModel> {
	return getAgentModelAsync(config, {
		taskType: "TOOL_CALLING",
		temperature: options.temperature ?? 0.2,
		maxTokens: options.maxTokens ?? 4000,
		retryCount: options.retryCount,
	});
}
