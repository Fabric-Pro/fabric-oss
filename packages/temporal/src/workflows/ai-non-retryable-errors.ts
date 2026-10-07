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
 * The first two are verdicts about CONFIGURATION, not about the provider call:
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
 *  - `SubscriptionPlanExhaustedError` — the member's own ChatGPT plan has no
 *    usage left in its window (Fizzy #2939), thrown by the plan model wrapper
 *    in `@repo/ai`. The window resets in hours, and OpenAI asks apps not to
 *    repeat the request in the meantime.
 *  - `ChatGptPlanAuthError` — the member's plan is on but its sign-in must be
 *    renewed (or is gone). Only the member can fix it, and Fabric never falls
 *    back to the organization's API billing on its own.
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
	"SubscriptionPlanExhaustedError",
	"ChatGptPlanAuthError",
] as const;

/**
 * Failure types a Glossy edition build (Fizzy #2589) throws as non-retryable
 * `ApplicationFailure`s, each a verdict no retry can change:
 *
 *  - `AI_PROVIDER_NOT_CONFIGURED` — the resolver found no provider for the
 *    editor in the project's organization (KTD21, AE6);
 *  - `SOURCE_DOCUMENT_DELETED` — the document, its edition, or its project is
 *    gone or in the trash, including a foreign-key violation (P2003) from a
 *    write racing the delete;
 *  - `ACCESS_REVOKED` — the editor who started the build lost edit access, or
 *    the document's organization or project no longer matches the build;
 *  - `NOTHING_TO_PRESENT` — no main-flow section survives cleanup;
 *  - `NOT_ELIGIBLE` — the rollout gate is off, the type is not eligible, or
 *    the document is mid-generation (R3);
 *  - `SUPERSEDED` — another attempt holds the build claim (KTD4). The run
 *    marks its own attempt superseded and stops without a failure write.
 *
 * The activities mark each throw non-retryable already; the build workflow
 * also names them in `nonRetryableErrorTypes`, so a throw that forgets the
 * flag still stops at its first attempt. The same strings are the codes the
 * attempt row persists. Plain literals: workflow code imports this module.
 */
export const GLOSSY_BUILD_NON_RETRYABLE_ERROR_TYPES = [
	"AI_PROVIDER_NOT_CONFIGURED",
	"SOURCE_DOCUMENT_DELETED",
	"ACCESS_REVOKED",
	"NOTHING_TO_PRESENT",
	"NOT_ELIGIBLE",
	"SUPERSEDED",
] as const;

export type GlossyBuildNonRetryableErrorType =
	(typeof GLOSSY_BUILD_NON_RETRYABLE_ERROR_TYPES)[number];

/**
 * The same types, for membership checks on a failure's recorded type. A
 * module-level constant built from the literals above, so workflow code may
 * import it: nothing here reads a clock, the environment, or I/O.
 */
export const GLOSSY_BUILD_NON_RETRYABLE_ERROR_TYPE_SET: ReadonlySet<string> =
	new Set<string>(GLOSSY_BUILD_NON_RETRYABLE_ERROR_TYPES);
