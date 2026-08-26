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

// Legacy sync alias for getAgentModelSync (now getAgentModelFromConfig)
// Note: This is sync and requires config to be passed from runtime
export function getAgentModelSync(
	providerConfig?: ProviderConfig,
	options: ModelOptions = {},
) {
	if (!providerConfig?.apiKey) {
		throw new Error(
			"[TaskPlanner] No AI provider config passed. " +
				"Provider configuration must be passed from the CopilotKit runtime. " +
				"Ensure the agent is invoked with proper tenant context.",
		);
	}
	return createProviderModel(providerConfig, options);
}

// Legacy createModel function - no longer supports GROQ_API_KEY fallback
// SECURITY: Direct environment variable access bypasses user preferences
// and the centralized AI model configuration
export function createModel(_temperature = 0.3) {
	throw new Error(
		"[TaskPlanner] createModel() is deprecated. " +
			"Use getAgentModelSync(providerConfig, options) with config from runtime, " +
			"or getAgentModelAsync() for API fallback support.",
	);
}
