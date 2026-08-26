/**
 * Model Factory Utility
 *
 * Re-exports the primary model factory functions from @repo/agent-core.
 * All agents should use getAgentModelAsync() to get models configured
 * from CopilotKit runtime or fetched from API using tenant context.
 */

// Primary model factory functions from centralized source
export type { ModelOptions } from "@repo/agent-core";

// Backward-compatible aliases
import {
	createProviderModel,
	type ModelOptions,
	type RuntimeProviderConfig,
} from "@repo/agent-core";

// Legacy alias for ProviderConfig (now RuntimeProviderConfig)
export type ProviderConfig = RuntimeProviderConfig;

// Legacy alias for getAgentModel (now getAgentModelFromConfig)
// Note: This is sync and requires config to be passed from runtime
export function getAgentModel(
	providerConfig?: ProviderConfig,
	options: ModelOptions = {},
) {
	if (!providerConfig?.apiKey) {
		throw new Error(
			"[StoryBreakdown] No AI provider config passed. " +
				"Provider configuration must be passed from the CopilotKit runtime. " +
				"Ensure the agent is invoked with proper tenant context.",
		);
	}
	return createProviderModel(providerConfig, options);
}

// Legacy createModel function - no longer supports GROQ_API_KEY fallback
// SECURITY: Direct environment variable access bypasses user preferences
// and the centralized AI model configuration
export function createModel(_retryCount = 0) {
	throw new Error(
		"[StoryBreakdown] createModel() is deprecated. " +
			"Use getAgentModel(providerConfig, options) with config from runtime, " +
			"or getAgentModelAsync() for API fallback support.",
	);
}
