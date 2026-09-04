/**
 * Failure types that no retry can turn into a success on an activity that
 * invokes a model.
 *
 * Temporal records an activity failure's type as `error.constructor?.name ??
 * error.name` (see `@temporalio/common`'s `ensureApplicationFailure`), so the
 * strings here are the class names thrown by `@repo/ai` / `@repo/payments`,
 * matched by the server before it schedules the next attempt. The error object
 * itself is NOT altered, so any message-based detection downstream (route
 * layer, `classifyBacklogAnalysisError`) keeps working unchanged.
 *
 * Both entries are verdicts about CONFIGURATION, not about the provider call:
 *
 *  - `AIProviderNotConfiguredError` — the tenant configured no provider, so
 *    model resolution refuses (`packages/ai/lib/dynamic-model-selector.ts`).
 *    Since the platform-key fallback closed on the user-facing path (Fizzy
 *    #1875) this is deterministic and common: without it here, every scheduled
 *    run for every provider-less tenant burns its whole retry budget — five
 *    attempts and several minutes of backoff — to arrive at the same refusal
 *    it had in the first millisecond.
 *  - `AiUsageLimitExceededError` — a HARD `AiUsageLimit` is exhausted. Limits
 *    are windowed in hours or days; a retry ladder measured in seconds cannot
 *    outlast one.
 *
 * Spread this into `retry.nonRetryableErrorTypes` on every proxy whose
 * activities reach a model, alongside whatever workflow-specific types that
 * proxy already names:
 *
 * ```ts
 * retry: {
 *   maximumAttempts: 3,
 *   nonRetryableErrorTypes: [...AI_NON_RETRYABLE_ERROR_TYPES, "ValidationError"],
 * }
 * ```
 *
 * This module is imported by workflow code, so it must stay free of runtime
 * imports — plain string literals only, nothing the Temporal sandbox rejects.
 */
export const AI_NON_RETRYABLE_ERROR_TYPES = [
	"AIProviderNotConfiguredError",
	"AiUsageLimitExceededError",
] as const;
