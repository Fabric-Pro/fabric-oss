import { findAiUsageLimitError } from "@repo/ai/lib/find-usage-limit-error";

/** What the UI message stream sends for any error that is not a usage limit. */
export const SIDEKICK_STREAM_ERROR_TEXT = "An error occurred.";

/**
 * The `errorText` the Sidekick's UI message stream sends for a stream error.
 *
 * The model checks the HARD usage limits before each step's request, so a
 * multi-step turn can be refused after it has started streaming; the HTTP
 * status is already sent by then. A limit refusal (bare, or inside the AI
 * SDK's `RetryError`) is sent as the same JSON body the route's 429 carries,
 * which `AgentBuilderSidekick` parses out of the error message to show the
 * shared limit toast. Every other error keeps the SDK's masked default, so
 * no server detail reaches the client.
 *
 * Kept out of `route.ts`: a Next route module may only export handlers.
 */
export function sidekickStreamErrorText(error: unknown): string {
	const limitError = findAiUsageLimitError(error);
	if (!limitError) {
		return SIDEKICK_STREAM_ERROR_TEXT;
	}
	return JSON.stringify({
		error: limitError.message,
		code: "AI_USAGE_LIMIT_EXCEEDED",
		data: {
			limitId: limitError.limitId,
			dimension: limitError.dimension,
			window: limitError.window,
			used: limitError.used.toString(),
			max: limitError.max.toString(),
			manageLimitsUrl: limitError.manageLimitsUrl,
		},
	});
}
