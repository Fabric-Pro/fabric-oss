/**
 * Routing Module
 *
 * Handles task analysis and routing decisions for the orchestrator.
 * Includes capability discovery and matching with semantic search support.
 *
 * Module structure:
 * - analyze-and-route.ts: Main routing activity
 * - intent/: User intent detection utilities
 * - capability-registry.ts: Capability discovery and matching
 * - capability-matcher.ts: Dynamic capability matching
 * - capability-descriptor.ts: Capability description utilities
 * - semantic-intent-matcher.ts: Semantic-based intent matching
 */

export { analyzeAndRoute, shouldSearchIntegrations } from "./analyze-and-route";
// Phase 1: Dynamic Capability Discovery
export {
	type AgentCapabilityDescriptor,
	type AgentCapabilityMatrix,
	type AgentMatchResult,
	type CapabilityMatchResult,
	cardCapabilitiesToDescriptor,
	extractKeywords,
	extractTriggerPhrases,
	inferOperationType,
	inferRiskLevel,
	inferSideEffects,
	isOperationReversible,
	type ToolCapabilityDescriptor,
	type ToolErrorPattern,
	type ToolMatchResult,
} from "./capability-descriptor";
export {
	addToolErrorPattern,
	addToolSuccessPattern,
	analyzeTask,
	type CapabilityMatcherOptions,
	matchCapabilities as matchCapabilitiesDynamic,
	type RequiredCapability,
	type TaskAnalysis,
	updateDescriptorMetrics,
} from "./capability-matcher";
export {
	discoverCapabilities,
	getAvailableAgentsList,
	getAvailableMcpToolsList,
	matchCapabilities,
	matchCapabilitiesHybrid,
	matchCapabilitiesSemantic,
	type SemanticMatchOptions,
} from "./capability-registry";
// Intent detection (extracted for reusability)
export {
	detectFabricPattern,
	detectUserIntent,
	type FabricAiCapability,
	type PrioritizedCapabilities,
	type UserIntent,
} from "./intent";
