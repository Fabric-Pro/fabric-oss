import {
	type BudgetMetadata,
	computeMaxOutputTokenBudget,
	providerNeedsExplicitBudget,
} from "@repo/ai/lib/output-token-budget";
import type { AIProvider } from "@repo/database";

/**
 * Backend reasoning mode after normalizeReasoningMode collapses the
 * user-facing "lite" | "balanced" | "deep" | "planner" to this triple.
 *
 * Intentionally duplicated from
 * `apps/web/app/api/agents/fabric-ai/stream/normalize-reasoning-mode.ts`
 * to avoid a cross-package import dependency (temporal cannot depend on
 * apps/web). Keep in sync if the canonical type changes.
 */
export type BackendReasoningMode = "lite" | "balanced" | "pro";

/**
 * Default token budget for Anthropic extended thinking. Set to 5000 — the
 * low end of "useful" per Anthropic's published guidance. Higher values give
 * the model more reasoning room at the cost of latency and tokens; lower
 * values risk truncated reasoning. Configurable later if cost analytics
 * warrant.
 */
const ANTHROPIC_THINKING_BUDGET_TOKENS = 5000;

/**
 * Minimum `max_tokens` to pass to streamText when Anthropic thinking is
 * enabled. Anthropic enforces `thinking.budget_tokens < max_tokens`
 * strictly — submitting a request with the AI SDK's lower default (4096
 * for Claude) and thinking.budget_tokens=5000 fails with HTTP 400. The
 * +11000 buffer above the thinking budget reserves room for the actual
 * reply content; production reply budgets in tool-calling workflows
 * rarely exceed ~10K tokens, so 16000 is comfortable without inflating
 * cost unnecessarily (max_tokens is an upper bound, not a guaranteed
 * spend).
 *
 * Background: PR #1093 enabled "deep" reasoning on the Fabric Loom
 * launcher without setting max_tokens, which immediately broke
 * `executeDirectChatActivity` for every Claude-routed call. PR #1098
 * reverted reasoning to "balanced" as a hotfix. This constant is the
 * proper fix — paired with `getMaxOutputTokensForProviderOptions()`
 * below, it lets the caller pass a safe max_tokens whenever thinking
 * is enabled.
 *
 * Exported for tests.
 */
export const ANTHROPIC_THINKING_MIN_MAX_TOKENS = 16000;

/**
 * Returns the `maxOutputTokens` value the caller should pass to
 * `streamText()` to satisfy Anthropic's `thinking.budget_tokens < max_tokens`
 * constraint when the returned `providerOptions` from
 * `buildProviderOptions()` enables thinking. Returns `undefined` when no
 * thinking opt-in was requested (caller can omit `maxOutputTokens` and
 * let the SDK pick its default).
 *
 * Keep this helper paired with `buildProviderOptions` — every call site
 * that consumes one should consume the other together. The pairing is
 * what prevents the "thinking enabled but max_tokens too small" 400
 * regression from re-occurring.
 *
 * @param providerOptions - The value returned by `buildProviderOptions()`.
 */
export function getMaxOutputTokensForProviderOptions(
	providerOptions:
		| { anthropic: { thinking: { type: "enabled"; budgetTokens: number } } }
		| undefined,
): number | undefined {
	if (!providerOptions?.anthropic?.thinking) {
		return undefined;
	}
	return ANTHROPIC_THINKING_MIN_MAX_TOKENS;
}

/**
 * Ceiling requested for a Direct chat turn when Anthropic extended thinking
 * is off. Matches the orchestrator engine's explicit 16,384 so the same
 * question cannot answer in full on one engine and truncate on the other,
 * and sits 2x above the ceiling Databricks injects when a request omits
 * `max_tokens`. Deliberately below `computeMaxOutputTokenBudget`'s 32,768
 * default: providers that admit against TPM/OTPM reserve the REQUESTED
 * budget, and a chat turn does not need that headroom.
 *
 * Exported for tests.
 */
export const DIRECT_CHAT_OUTPUT_TOKEN_CEILING = 16_384;

/**
 * Resolves the `maxOutputTokens` for a Direct chat turn.
 *
 * Before this existed, the activity sent `max_tokens` ONLY when Anthropic
 * extended thinking was enabled — that is `pro` reasoning mode alone, so
 * every default turn sent nothing. Two providers substitute a small ceiling
 * of their own when the field is omitted: Databricks injects 8,192 and
 * `@ai-sdk/anthropic` falls back to 4,096 for model names it does not
 * recognize, which includes Databricks serving aliases. A long chat answer
 * was cut off mid-sentence with no error and no way to tell it had
 * happened.
 *
 * Order matters. The thinking value wins whenever it is set: it is the
 * floor that keeps `max_tokens > thinking.budget_tokens`, and running it
 * through the budget helper's context-window clamp could drop it below the
 * thinking budget and bring back the HTTP 400 that PR #1098 hotfixed.
 *
 * The computed budget is deliberately limited to the providers that
 * substitute a small default. `computeMaxOutputTokenBudget` returns a number
 * for ANY provider whose catalog row carries `maxOutputTokens` — the
 * provider gate inside it only chooses the FALLBACK cap — so calling it
 * unconditionally would start sending `max_tokens` on providers that never
 * had the truncation problem. That is not free: several providers admit
 * requests against TPM/OTPM using the REQUESTED budget, so an unnecessary
 * one reserves quota for output that was never going to be produced. This
 * call site previously sent nothing at all on those providers, and it still
 * does.
 */
export function resolveOutputTokenBudget(opts: {
	providerOptions:
		| { anthropic: { thinking: { type: "enabled"; budgetTokens: number } } }
		| undefined;
	metadata: BudgetMetadata;
	promptChars: number;
}): number | undefined {
	const thinkingFloor = getMaxOutputTokensForProviderOptions(
		opts.providerOptions,
	);
	if (thinkingFloor !== undefined) {
		return thinkingFloor;
	}
	if (!providerNeedsExplicitBudget(opts.metadata.provider)) {
		return undefined;
	}
	return computeMaxOutputTokenBudget(opts.metadata, {
		promptChars: opts.promptChars,
		ceilingTokens: DIRECT_CHAT_OUTPUT_TOKEN_CEILING,
	});
}

/**
 * Model string prefixes that identify Claude models when routing through
 * a gateway (e.g., Vercel AI Gateway).
 */
const CLAUDE_MODEL_PREFIXES = ["claude", "anthropic/"];

/**
 * Returns true when the provider + model combination will result in a request
 * being processed by Anthropic's API (where the `thinking` opt-in is required).
 *
 * Two cases:
 * 1. ANTHROPIC_DIRECT — always Anthropic's API.
 * 2. VERCEL_GATEWAY with a Claude model string — the gateway routes claude/*
 *    and bare `claude-*` model names to Anthropic's API.
 *
 * AWS_BEDROCK and AZURE_AI_FOUNDRY are intentionally excluded: Bedrock uses
 * a separate API surface that does not accept the Anthropic `thinking` toggle
 * via `providerOptions`, and Azure Foundry uses the OpenAI-compatible API.
 *
 * OPENROUTER is also excluded even when routing Claude models: OpenRouter's
 * API surface does not currently pass `providerOptions.anthropic.thinking`
 * through to Anthropic's API. Re-evaluate this exclusion if OpenRouter adds
 * native support for the thinking toggle.
 */
export function isAnthropicProvider(
	provider: AIProvider,
	modelString: string,
): boolean {
	if (provider === "ANTHROPIC_DIRECT") {
		return true;
	}
	if (provider === "VERCEL_GATEWAY") {
		const lower = modelString.toLowerCase();
		return CLAUDE_MODEL_PREFIXES.some((prefix) => lower.startsWith(prefix));
	}
	return false;
}

/**
 * Builds the optional `providerOptions` block passed to `streamText`. Returns a
 * value ONLY when BOTH conditions are met:
 *
 *   1. The provider + model combination routes to Anthropic's API
 *      (`ANTHROPIC_DIRECT`, or `VERCEL_GATEWAY` with a Claude model string).
 *   2. The reasoning mode is "pro" — meaning the user opted into deep/planner
 *      mode via the UI (these modes are normalized to "pro" by Task 4b's
 *      `normalizeReasoningMode` at the route boundary).
 *
 * Returning undefined for "lite" and "balanced" preserves the cheap/fast cost
 * and latency profile for non-reasoning modes — otherwise Claude users on cheap
 * modes would silently pay +5000 thinking tokens per turn (Codex P2 finding on
 * PR #976).
 *
 * o1 / o3 / DeepSeek R1 / Gemini 2.5 surface reasoning natively (or via the
 * `extractReasoningMiddleware` wired in `packages/ai/model-factory.ts`) and need
 * no provider-side toggle.
 *
 * @param provider - `AIProvider` enum from `metadata.provider`.
 * @param modelString - Resolved model string from `metadata.modelString`.
 * @param reasoningMode - Backend-normalized reasoning mode. Only "pro" enables
 *                        Anthropic thinking. Undefined is treated as non-pro
 *                        (defense in depth). See normalize-reasoning-mode.ts.
 */
export function buildProviderOptions(
	provider: AIProvider,
	modelString: string,
	reasoningMode: BackendReasoningMode | undefined,
):
	| { anthropic: { thinking: { type: "enabled"; budgetTokens: number } } }
	| undefined {
	if (reasoningMode !== "pro") {
		return undefined;
	}
	if (!isAnthropicProvider(provider, modelString)) {
		return undefined;
	}
	return {
		anthropic: {
			thinking: {
				type: "enabled",
				budgetTokens: ANTHROPIC_THINKING_BUDGET_TOKENS,
			},
		},
	};
}
