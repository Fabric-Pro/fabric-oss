import { ActivityFailure, ApplicationFailure } from "@temporalio/common";
import { patched } from "@temporalio/workflow";
import { isUsageLimitRefusalText } from "../../lib/ai-usage-limit-refusal";

import type { DirectChatUsageLimitRefusal } from "../../types";

/** Preserve the refusal text Temporal wraps at the activity boundary. */
export function orchestratorErrorMessage(
	error: unknown,
	fallback = "Unknown error",
): string {
	const cause = error instanceof ActivityFailure ? error.cause : error;
	if (
		cause instanceof ApplicationFailure &&
		cause.type === "AiUsageLimitExceededError"
	) {
		return cause.message;
	}
	return error instanceof Error ? error.message : fallback;
}

/**
 * A stream failure ends the phase without scheduling another model call.
 * Its message is already the person's (the activity's shared provider
 * failure message), shown as Direct shows its own, with no prefix.
 */
export function streamFailureResult(result: {
	message: string;
	usageLimit?: DirectChatUsageLimitRefusal;
}) {
	return {
		success: false,
		error: result.message,
		shouldContinue: false,
		...(result.usageLimit ? { usageLimit: result.usageLimit } : {}),
	};
}

/** Evaluate the replay marker only for a parseable usage refusal. */
export function shouldAbortUsageLimit(error: unknown): boolean {
	return (
		isUsageLimitRefusalText(error) &&
		patched("orch-plan-step-usage-limit-abort-v1")
	);
}
