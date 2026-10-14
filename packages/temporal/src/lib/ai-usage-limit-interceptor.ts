/**
 * Unwraps a HARD AI usage-limit refusal at the activity boundary.
 *
 * Temporal records an activity failure's type as the thrown error's class
 * name, and activity proxies that list `AiUsageLimitExceededError` in
 * `nonRetryableErrorTypes` (`workflows/ai-non-retryable-errors.ts`) do not
 * retry that type. The `@repo/ai` models check the limits before each
 * request, and the AI SDK wraps a refusal of its own retry in a `RetryError`;
 * an activity that let that escape would fail with type `RetryError`, which
 * those lists do not name.
 *
 * Registered once on the worker, innermost, so an activity throws the
 * unwrapped `AiUsageLimitExceededError` instead, and its failure type is
 * `AiUsageLimitExceededError` whatever proxy scheduled it. Whether that stops
 * a retry is still up to the proxy's own list. Any other error, and a bare
 * limit error, passes through unchanged. Workflow code must never import
 * this file.
 */

import { findAiUsageLimitError } from "@repo/ai/lib/find-usage-limit-error";
import type {
	ActivityExecuteInput,
	ActivityInboundCallsInterceptor,
	Next as ActivityNext,
} from "@temporalio/worker";

export class AiUsageLimitActivityInboundInterceptor
	implements ActivityInboundCallsInterceptor
{
	async execute(
		input: ActivityExecuteInput,
		next: ActivityNext<ActivityInboundCallsInterceptor, "execute">,
	): Promise<unknown> {
		try {
			return await next(input);
		} catch (error) {
			throw findAiUsageLimitError(error) ?? error;
		}
	}
}
