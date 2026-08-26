/**
 * Delegation Module
 *
 * Handles all agent delegation functionality including:
 * - Endpoint resolution
 * - Capability detection
 * - A2A protocol communication
 * - Message building
 */

// Agent capabilities
export {
	agentHasCapability,
	determineDelegationStrategy,
	getAgentCapabilities,
	isAgentSuitableForTask,
} from "./agent-capabilities";
// Delegation
export { delegateToAgent } from "./delegate-to-agent";
// Message building
export {
	buildContextualDelegationMessage,
	buildDelegationMessage,
	buildResearchQueryMessage,
	buildSimpleDelegationMessage,
	summarizeConversationHistory,
	truncateText,
} from "./message-builder";
// Endpoint resolution
export { resolveAgentEndpoint, resolveAgentUrl } from "./resolve-endpoint";
