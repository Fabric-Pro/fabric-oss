import type { AiUsageLimitExceededError } from "@repo/payments/lib/ai-usage-limit-error";
import type { DirectChatUsageLimitRefusal } from "../../types";

/**
 * A usage-limit refusal as data the workflow result can carry: the route
 * sends it as the `AI_USAGE_LIMIT_EXCEEDED` event's payload, so the BigInt
 * counters become decimal strings, as at every other limit surface.
 */
export function toUsageLimitRefusal(
	error: AiUsageLimitExceededError,
): DirectChatUsageLimitRefusal {
	return {
		message: error.message,
		limitId: error.limitId,
		dimension: error.dimension,
		window: error.window,
		used: error.used.toString(),
		max: error.max.toString(),
		manageLimitsUrl: error.manageLimitsUrl,
	};
}
