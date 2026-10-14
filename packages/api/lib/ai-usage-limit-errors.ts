/**
 * A HARD AI usage-limit refusal as the client-facing oRPC error.
 *
 * `domainErrorMapper` (orpc/procedures.ts) maps it for every protected
 * procedure, so the client receives `code: "AI_USAGE_LIMIT_EXCEEDED"` with the
 * payload the shared limit toast reads. A refusal can come from model
 * resolution or from the check the model repeats before each request it
 * sends; the second can reach the procedure inside the AI SDK's `RetryError`,
 * so the error is found with `findAiUsageLimitError`, never `instanceof`.
 */
import { ORPCError } from "@orpc/client";
import { findAiUsageLimitError } from "@repo/ai/lib/find-usage-limit-error";

export function aiUsageLimitToORPCError(
	error: unknown,
): ORPCError<"AI_USAGE_LIMIT_EXCEEDED", unknown> | null {
	const limitError = findAiUsageLimitError(error);
	if (!limitError) {
		return null;
	}
	// BigInts as strings, so the JSON serializer accepts them and the client
	// needs no BigInt support.
	return new ORPCError("AI_USAGE_LIMIT_EXCEEDED", {
		message: limitError.message,
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
