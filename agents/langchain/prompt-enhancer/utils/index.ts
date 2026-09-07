/**
 * Prompt Enhancer Utils Module
 *
 * Constants and utility functions for prompt enhancement.
 */

// Retry helpers now live in @repo/agent-core (shared across the LangGraph
// agents) — re-exported here under the names this agent's nodes and tests
// already use.
export {
	calculateRetryDelay,
	isJsonParseError,
	MAX_NODE_RETRIES as MAX_RETRIES,
	sleep,
} from "@repo/agent-core";
// Export model factory functions
export {
	extractProviderConfig,
	getAgentModel,
	// Async version with API fallback (recommended for tenant context auth)
	getAgentModelAsync,
} from "./model-factory";

/**
 * Passed explicitly as `recursionLimit` at every graph invoke/stream call
 * site. Single-node graph (~1 + MAX_JSON_RETRIES supersteps per turn), so this
 * is generous headroom set deliberately rather than LangGraph's implicit 25.
 */
export const DEFAULT_RECURSION_LIMIT = 25;

/**
 * Maximum number of retries for JSON parse errors
 */
export const MAX_JSON_RETRIES = 4;
