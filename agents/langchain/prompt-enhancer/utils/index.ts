/**
 * Prompt Enhancer Utils Module
 *
 * Constants and utility functions for prompt enhancement.
 */

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
 * Maximum number of retries for standard errors
 */
export const MAX_RETRIES = 3;

/**
 * Maximum number of retries for JSON parse errors
 */
export const MAX_JSON_RETRIES = 4;

/**
 * Check if an error is a JSON parse error
 *
 * JSON parse errors get extra retry attempts.
 *
 * @param error - The error to check
 * @returns Whether it's a JSON parse error
 */
export function isJsonParseError(error: Error): boolean {
	const errorMsg = error.message;
	return (
		errorMsg.includes("Failed to parse tool call arguments as JSON") ||
		errorMsg.includes("Invalid JSON") ||
		errorMsg.includes("JSON parse error")
	);
}

/**
 * Calculate retry delay with exponential backoff
 *
 * @param retryCount - Current retry count
 * @returns Delay in milliseconds (capped at 4000ms)
 */
export function calculateRetryDelay(retryCount: number): number {
	return Math.min(500 * 2 ** retryCount, 4000);
}

/**
 * Wait for the specified delay
 *
 * @param ms - Milliseconds to wait
 */
export async function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
