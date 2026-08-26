/**
 * Backlog Updater Utils Module
 */

export { getAgentModelAsync } from "./model-factory";

/**
 * Passed explicitly as `recursionLimit` at every graph invoke/stream call
 * site. Single-node graph (~1 + MAX_RETRIES supersteps per turn), so this is
 * generous headroom set deliberately rather than LangGraph's implicit 25.
 */
export const DEFAULT_RECURSION_LIMIT = 30;
export const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1000;

export function isRetryableError(error: Error): boolean {
	const msg = error.message;
	return (
		msg.includes("Failed to parse tool call arguments as JSON") ||
		msg.includes("Invalid JSON") ||
		msg.includes("timeout") ||
		msg.includes("rate limit") ||
		msg.includes("ECONNREFUSED")
	);
}

export function calculateRetryDelay(retryCount: number): number {
	return RETRY_DELAY_MS * 2 ** retryCount;
}

export async function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
