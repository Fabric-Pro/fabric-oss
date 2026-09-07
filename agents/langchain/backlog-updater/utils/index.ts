/**
 * Backlog Updater Utils Module
 */

// Retry helpers now live in @repo/agent-core (shared across the LangGraph
// agents) — re-exported here under the names this agent's nodes already
// use. NOTE: isRetryableError now also matches "JSON parse error" and
// "network" (the shared predicate's union of substrings), which this agent
// did not previously check for.
export {
	calculateRetryDelay,
	isRetryableError,
	MAX_NODE_RETRIES as MAX_RETRIES,
	sleep,
} from "@repo/agent-core";
export { getAgentModelAsync } from "./model-factory";

/**
 * Passed explicitly as `recursionLimit` at every graph invoke/stream call
 * site. Single-node graph (~1 + MAX_RETRIES supersteps per turn), so this is
 * generous headroom set deliberately rather than LangGraph's implicit 25.
 */
export const DEFAULT_RECURSION_LIMIT = 30;
