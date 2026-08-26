/**
 * Retry Utilities
 *
 * Retry logic with exponential backoff for LLM calls.
 */

/** Maximum number of retries */
export const MAX_RETRIES = 3;

/** Base delay between retries in milliseconds */
export const RETRY_DELAY_MS = 1000;

/**
 * Execute a function with retry logic and exponential backoff
 *
 * Handles JSON parse errors with additional retries since LLMs
 * sometimes produce malformed JSON that can be fixed on retry.
 *
 * @param fn - Function to execute
 * @param maxRetries - Maximum number of retries
 * @param currentRetry - Current retry count (internal use)
 * @returns Result from the function
 */
export async function withRetry<T>(
	fn: () => Promise<T>,
	maxRetries = MAX_RETRIES,
	currentRetry = 0,
): Promise<T> {
	try {
		return await fn();
	} catch (error) {
		const errorMsg = error instanceof Error ? error.message : String(error);
		const isJsonParseError =
			errorMsg.includes("Failed to parse tool call arguments as JSON") ||
			errorMsg.includes("Invalid JSON") ||
			errorMsg.includes("JSON parse error");
		const isNetworkError =
			errorMsg.includes("timeout") ||
			errorMsg.includes("rate limit") ||
			errorMsg.includes("network");

		// JSON parse errors get extra retries
		const effectiveMaxRetries = isJsonParseError
			? maxRetries + 1
			: maxRetries;

		if (currentRetry >= effectiveMaxRetries) {
			throw error;
		}

		const isRetryable =
			error instanceof Error && (isJsonParseError || isNetworkError);
		if (isRetryable) {
			const delay = RETRY_DELAY_MS * 2 ** currentRetry;
			console.log(
				`[Task Planner] Retrying in ${delay}ms (attempt ${currentRetry + 1}/${effectiveMaxRetries})`,
				{ isJsonParseError, isNetworkError },
			);
			await new Promise((resolve) => setTimeout(resolve, delay));
			return withRetry(fn, maxRetries, currentRetry + 1);
		}
		throw error;
	}
}
