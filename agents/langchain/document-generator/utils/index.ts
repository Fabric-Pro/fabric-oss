/**
 * Document Generator Utils Module
 *
 * Constants and utility functions for document generation.
 */

// Export model factory functions
export {
	getAgentModel,
	// Async version with API fallback (recommended for tenant context auth)
	getAgentModelAsync,
} from "./model-factory";

/**
 * Passed explicitly as `recursionLimit` at every graph invoke/stream call
 * site. Single-node graph (~1 + MAX_RETRIES supersteps per turn), so this is
 * generous headroom set deliberately rather than LangGraph's implicit 25.
 */
export const DEFAULT_RECURSION_LIMIT = 25;

/**
 * Maximum number of retries for transient failures
 */
export const MAX_RETRIES = 3;

/**
 * Base delay in milliseconds for retry backoff
 */
export const RETRY_DELAY_MS = 1000;

/**
 * Check if an error is retryable
 *
 * @param error - The error to check
 * @returns Whether the error is retryable
 */
export function isRetryableError(error: Error): boolean {
	const errorMsg = error.message;

	const isJsonParseError =
		errorMsg.includes("Failed to parse tool call arguments as JSON") ||
		errorMsg.includes("Invalid JSON") ||
		errorMsg.includes("JSON parse error");

	const isNetworkError =
		errorMsg.includes("timeout") ||
		errorMsg.includes("rate limit") ||
		errorMsg.includes("network") ||
		errorMsg.includes("ECONNREFUSED");

	return isJsonParseError || isNetworkError;
}

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
 * @returns Delay in milliseconds
 */
export function calculateRetryDelay(retryCount: number): number {
	return RETRY_DELAY_MS * 2 ** retryCount;
}

/**
 * Wait for the specified delay
 *
 * @param ms - Milliseconds to wait
 */
export async function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
