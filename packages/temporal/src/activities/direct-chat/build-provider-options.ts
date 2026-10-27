import { isAnthropicAdaptiveOnlyModel } from "@repo/agent-types";
import {
	type BudgetMetadata,
	clampRequestedOutputTokens,
	computeMaxOutputTokenBudget,
	providerNeedsExplicitBudget,
} from "@repo/ai/lib/output-token-budget";
import { isPromptCacheTarget } from "@repo/ai/prompt-cache";
import type { AIProvider } from "@repo/database";
import { isVoiceTurn } from "../shared/voice-turn-policy";

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
 * The `providerOptions` block `buildProviderOptions` returns when it enables
 * Anthropic thinking. Budgeted extended thinking for Claude releases that
 * accept it; adaptive thinking for adaptive-only Claude (Opus 4.7/4.8 and the
 * 5.x generation), which returns HTTP 400 for the budgeted form.
 */
export type AnthropicThinkingProviderOptions = {
	anthropic: {
		thinking:
			| { type: "enabled"; budgetTokens: number }
			| { type: "adaptive" };
	};
};

/**
 * The `providerOptions` block a spoken turn carries on an OpenAI reasoning
 * model, asking it to think as little as it supports.
 */
export type OpenAiReasoningProviderOptions = {
	openai: { reasoningEffort: "minimal" | "low" };
};

/**
 * Everything `buildProviderOptions` can return. The two blocks are independent:
 * thinking is Anthropic's, the reasoning effort is OpenAI's.
 */
export type DirectChatProviderOptions =
	Partial<AnthropicThinkingProviderOptions> &
		Partial<OpenAiReasoningProviderOptions>;

/**
 * Default token budget for Anthropic extended thinking. Set to 5000 — the
 * low end of "useful" per Anthropic's published guidance. Higher values give
 * the model more reasoning room at the cost of latency and tokens; lower
 * values risk truncated reasoning. Configurable later if cost analytics
 * warrant.
 */
const ANTHROPIC_THINKING_BUDGET_TOKENS = 5000;

/**
 * Default `max_tokens` to pass to streamText when Anthropic thinking is
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
 * starting budget; `resolveOutputTokenBudget` caps it to the catalog, and
 * `fitThinkingToOutputBudget` adjusts fixed thinking to leave answer room.
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
 * This is the starting budget. `resolveOutputTokenBudget` applies the
 * catalog cap, then `fitThinkingToOutputBudget` fits the thinking allowance
 * and answer floor under that cap before dispatch.
 *
 * @param providerOptions - The value returned by `buildProviderOptions()`.
 */
export function getMaxOutputTokensForProviderOptions(
	providerOptions: DirectChatProviderOptions | undefined,
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
 * The thinking value is capped by the catalog output limit and bypasses the
 * context-window clamp. The caller then uses `fitThinkingToOutputBudget` to
 * reduce or drop fixed thinking, reserving 1,024 tokens for the answer.
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
	providerOptions: DirectChatProviderOptions | undefined;
	metadata: BudgetMetadata;
	promptChars: number;
}): number | undefined {
	const thinkingFloor = getMaxOutputTokensForProviderOptions(
		opts.providerOptions,
	);
	if (thinkingFloor !== undefined) {
		return clampRequestedOutputTokens(thinkingFloor, opts.metadata);
	}
	if (!providerNeedsExplicitBudget(opts.metadata.provider)) {
		return undefined;
	}
	return computeMaxOutputTokenBudget(opts.metadata, {
		promptChars: opts.promptChars,
		ceilingTokens: DIRECT_CHAT_OUTPUT_TOKEN_CEILING,
	});
}

const MIN_FIXED_THINKING_TOKENS = 1_024;
const THINKING_ANSWER_FLOOR_TOKENS = 1_024;

/**
 * Fit fixed thinking under the resolved output budget, leaving 1,024 tokens
 * for the answer. Anthropic's fixed thinking needs at least 1,024 tokens;
 * drop the thinking block when that and the answer floor cannot both fit.
 * Adaptive thinking has no caller-specified token budget and is left alone.
 */
export function fitThinkingToOutputBudget(
	providerOptions: DirectChatProviderOptions | undefined,
	maxOutputTokens: number | undefined,
): DirectChatProviderOptions | undefined {
	const thinking = providerOptions?.anthropic?.thinking;
	if (
		!providerOptions ||
		thinking?.type !== "enabled" ||
		maxOutputTokens === undefined
	) {
		return providerOptions;
	}
	const budgetTokens = Math.min(
		thinking.budgetTokens,
		maxOutputTokens - THINKING_ANSWER_FLOOR_TOKENS,
	);
	if (budgetTokens < MIN_FIXED_THINKING_TOKENS) {
		const { anthropic: _anthropic, ...otherOptions } = providerOptions;
		return Object.keys(otherOptions).length > 0 ? otherOptions : undefined;
	}
	return {
		...providerOptions,
		anthropic: { thinking: { ...thinking, budgetTokens } },
	};
}

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
	return isPromptCacheTarget(provider, modelString);
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
 * Adaptive-only Claude (`isAnthropicAdaptiveOnlyModel` — Opus 4.7/4.8 and the
 * 5.x generation) rejects `thinking: { type: "enabled", budget_tokens }` with
 * HTTP 400, and `@ai-sdk/anthropic` forwards a caller-supplied `budgetTokens`
 * to the wire unchanged, so those models get `{ type: "adaptive" }` instead.
 * No `effort` is set: depth stays at the provider default.
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
 * @param featureKey - The caller's usage feature key. A voice turn (see
 *                     `isVoiceTurn`) asks OpenAI reasoning models for minimal
 *                     reasoning and never enables Anthropic thinking.
 */
export function buildProviderOptions(
	provider: AIProvider,
	modelString: string,
	reasoningMode: BackendReasoningMode | undefined,
	featureKey?: string,
): DirectChatProviderOptions | undefined {
	if (isVoiceTurn(featureKey)) {
		return buildVoiceTurnProviderOptions(provider, modelString);
	}
	if (reasoningMode !== "pro") {
		return undefined;
	}
	if (!isAnthropicProvider(provider, modelString)) {
		return undefined;
	}
	if (isAnthropicAdaptiveOnlyModel(modelString)) {
		return { anthropic: { thinking: { type: "adaptive" } } };
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

/** OpenAI's reasoning families: gpt-5 and gpt-6 (not their `-chat` variants) and the o-series. */
const OPENAI_REASONING_MODEL = /^(?:openai\/)?(?:gpt-[56](?!.*-chat)|o\d)/i;
/**
 * The first gpt-5 models (`gpt-5`, `-mini`, `-nano`) are the only ones that
 * accept "minimal"; gpt-5.1 and later, gpt-6 and the o-series start at "low".
 */
const OPENAI_MINIMAL_EFFORT_MODEL = /^(?:openai\/)?gpt-5(?:-(?:mini|nano))?$/i;

function isOpenAiReasoningTarget(
	provider: AIProvider,
	modelString: string,
): boolean {
	return (
		(provider === "OPENAI_DIRECT" || provider === "VERCEL_GATEWAY") &&
		OPENAI_REASONING_MODEL.test(modelString)
	);
}

/**
 * A spoken reply is one or two sentences that a person is waiting for, so the
 * model gets the least reasoning it accepts. A voice turn never opts into
 * Anthropic thinking either, whatever reasoning mode the agent has saved: the
 * budget would be spent before the first word.
 */
function buildVoiceTurnProviderOptions(
	provider: AIProvider,
	modelString: string,
): OpenAiReasoningProviderOptions | undefined {
	if (!isOpenAiReasoningTarget(provider, modelString)) {
		return undefined;
	}
	return {
		openai: {
			reasoningEffort: OPENAI_MINIMAL_EFFORT_MODEL.test(modelString)
				? "minimal"
				: "low",
		},
	};
}
