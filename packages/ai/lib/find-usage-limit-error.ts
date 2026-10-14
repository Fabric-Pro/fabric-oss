/**
 * Find a usage-limit rejection inside whatever an AI SDK call threw.
 *
 * The SDK retries a failed call, and an error thrown on the second or a later
 * attempt reaches the caller inside a `RetryError` (its `reason` depends on
 * whether retries were exhausted). A usage-limit rejection raised by the
 * per-call limit check before a retry can therefore reach the caller wrapped,
 * and a bare `instanceof` test on the
 * thrown value does not see it. A decision site that must not fall back to the
 * language model after a limit rejection (the retry would bill the spend the
 * limit refused) uses this instead, and rethrows the returned instance so
 * callers further up that test `instanceof` still match.
 */

import { AiUsageLimitExceededError } from "@repo/payments/lib/ai-usage-limit-error";
import { RetryError } from "ai";

/**
 * The `AiUsageLimitExceededError` carried by `error`, or undefined.
 *
 * Recognizes the error itself, and a `RetryError` whose `lastError` is one or
 * whose `errors` contains one. Only one level of `RetryError` is unwrapped, and
 * only the SDK's own `RetryError` is: any other shape returns undefined. Never
 * throws.
 */
export function findAiUsageLimitError(
	error: unknown,
): AiUsageLimitExceededError | undefined {
	try {
		if (error instanceof AiUsageLimitExceededError) {
			return error;
		}
		if (!RetryError.isInstance(error)) {
			return undefined;
		}
		if (error.lastError instanceof AiUsageLimitExceededError) {
			return error.lastError;
		}
		if (Array.isArray(error.errors)) {
			return error.errors.find(
				(entry): entry is AiUsageLimitExceededError =>
					entry instanceof AiUsageLimitExceededError,
			);
		}
	} catch {
		// An unreadable error is not a limit error.
	}
	return undefined;
}
