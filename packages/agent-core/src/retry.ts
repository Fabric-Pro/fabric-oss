/**
 * Agent Retry Helpers
 *
 * Application-level (whole-node) retry helpers shared by the LangGraph
 * agents under `agents/langchain/`. These sit ABOVE the SDK per-request
 * retry configured in `services/langchain-models.ts` (`DEFAULT_MAX_RETRIES`
 * / LangChain core's `AsyncCaller` + `pRetry`). Every node-level retry here
 * re-enters that SDK envelope — including its own exponential backoff — so
 * these are deliberately short: a small retry ceiling and a small, capped
 * backoff, not a second independent resilience layer.
 */

/**
 * Default ceiling for whole-node retries. Individual agents may keep a
 * larger or smaller local constant when their retry shape genuinely
 * differs (e.g. more corrective rounds for patch-mode convergence).
 */
export const MAX_NODE_RETRIES = 3;

/** Base delay for the exponential backoff, in milliseconds. */
export const RETRY_BASE_DELAY_MS = 500;

/** Upper bound on the backoff delay, in milliseconds. */
export const RETRY_MAX_DELAY_MS = 4000;

/**
 * Check if an error is a JSON parse error.
 *
 * JSON parse errors get extra retry attempts in most agents' node-retry
 * logic, since LLMs sometimes produce malformed JSON / tool-call arguments
 * that a retry can fix.
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
 * Check if an error is retryable: a JSON parse error, or a transient
 * network/rate-limit failure.
 *
 * @param error - The error to check
 * @returns Whether the error is retryable
 */
export function isRetryableError(error: Error): boolean {
	const errorMsg = error.message;

	const isNetworkError =
		errorMsg.includes("timeout") ||
		errorMsg.includes("rate limit") ||
		errorMsg.includes("network") ||
		errorMsg.includes("ECONNREFUSED");

	return isJsonParseError(error) || isNetworkError;
}

/**
 * Calculate retry delay with exponential backoff, capped at
 * {@link RETRY_MAX_DELAY_MS}.
 *
 * @param retryCount - Current retry count
 * @returns Delay in milliseconds
 */
export function calculateRetryDelay(retryCount: number): number {
	return Math.min(RETRY_BASE_DELAY_MS * 2 ** retryCount, RETRY_MAX_DELAY_MS);
}

/**
 * Wait for the specified delay.
 *
 * @param ms - Milliseconds to wait
 */
export async function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
