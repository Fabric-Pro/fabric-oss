/**
 * Model Factory Utility
 *
 * Re-exports the primary model factory functions from @repo/agent-core.
 * All agents should use getAgentModelAsync() to get models configured
 * from CopilotKit runtime or fetched from API using tenant context.
 */

// Primary model factory functions
export {
	extractProviderConfig,
	// Async version with API fallback (recommended for tenant context auth)
	getAgentModelAsync,
	getAgentModelFromConfig as getAgentModel,
} from "@repo/agent-core";
