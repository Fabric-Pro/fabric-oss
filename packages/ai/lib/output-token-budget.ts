/**
 * Output-token budget helper.
 *
 * ## The bug class this guards against
 *
 * The Vercel AI SDK sends no `max_tokens` unless a caller sets
 * `maxOutputTokens`. Two providers silently substitute a SMALL default when the
 * field is omitted, truncating any response whose output is large:
 *
 * - **Databricks** injects its own `max_tokens` of **8,192** on requests that
 *   omit one. A whole-document rewrite or generation blows past that and comes
 *   back cut off mid-output.
 * - **@ai-sdk/anthropic** falls back to **4,096** for model names it doesn't
 *   recognize (Databricks/Azure serving aliases, custom deployments). Same
 *   truncation, at an even lower ceiling.
 *
 * The fix is to send an EXPLICIT budget on the affected call sites. These
 * helpers centralize that budget math so every site clamps identically and can
 * never over-ask (which would 400) or under-ask (which would truncate).
 *
 * ## Two modes
 *
 * - {@link computeScaledOutputTokenBudget} — **scaled mode**, for sites whose
 *   output tracks the input: rewrites, extraction, "return the COMPLETE
 *   document" flows. The budget grows with `inputChars`.
 * - {@link computeMaxOutputTokenBudget} — **maximal mode**, for generation
 *   sites where output ≫ input (a whole PRD / HTML page from a short prompt).
 *   The budget is simply the largest the model (or gated fallback) allows.
 *
 * Both return `undefined` for providers that DON'T need the workaround and have
 * no known catalog cap — callers should then omit `maxOutputTokens` entirely
 * and let the SDK default stand.
 */

/** Floor for the requested output-token budget, regardless of input size. */
export const MIN_OUTPUT_TOKEN_BUDGET = 16_384;
/**
 * Default ceiling for maximal-mode requests. Several providers admit requests
 * against their rate limits using the REQUESTED `max_tokens`, not the tokens
 * actually generated — Azure OpenAI reserves it against deployment TPM and
 * Anthropic against OTPM — so asking for a model's full catalog cap (up to
 * 128,000) can 429 every call on a deployment whose quota sits below the
 * model's theoretical maximum, even when the expected output is small. 32,768
 * is 4× the Databricks-injected default that motivated explicit budgets — far
 * clear of the truncation bug class — while keeping quota reservation bounded.
 * Sites that genuinely need more can pass `ceilingTokens` explicitly.
 */
export const MAXIMAL_OUTPUT_TOKEN_CEILING = 32_768;
/**
 * Cap used when the catalog doesn't know the model's output limit but the
 * provider still needs an explicit budget (Databricks / Anthropic-direct).
 */
export const FALLBACK_OUTPUT_TOKEN_CAP = 64_000;

/**
 * Rough chars-per-token used to SIZE the desired budget (scaled mode). An
 * overestimate here is a harmless ceiling — the budget is clamped down to the
 * provider cap and context window afterward — and /3 is inherited from the
 * merged PR #2198 reference. NOT used for the context clamp, which needs a
 * conservative divisor (see CONTEXT_CLAMP_CHARS_PER_TOKEN).
 */
const CHARS_PER_TOKEN = 3;
/**
 * Chars-per-token used ONLY to estimate the prompt's input tokens in the
 * context clamp. Deliberately smaller (more conservative) than CHARS_PER_TOKEN:
 * here an UNDERESTIMATE of input tokens is what causes a provider
 * context-length 400 (input + output > window), so we over-count the input to
 * stay safely inside the window.
 *
 * Residual risk: pure-CJK prompts run ~1 token/char (or worse), so /2 can still
 * under-count them. Accepted — a real tokenizer dependency is too heavy for
 * this hot path, and a 1-char/token worst case would needlessly strangle
 * budgets for the dominant English/markdown content this helper serves.
 */
const CONTEXT_CLAMP_CHARS_PER_TOKEN = 2;
/** Slack added on top of 2x the estimated input tokens (scaled mode). */
const OVERHEAD_TOKENS = 2_048;
/** Tokens reserved below the context window as headroom for the estimated input. */
const CONTEXT_WINDOW_MARGIN_TOKENS = 1_024;

/**
 * The subset of `AIModelMetadata` the budget math needs. Kept structural so
 * callers can pass their resolved metadata directly without an import cycle.
 */
export interface BudgetMetadata {
	provider: string;
	/** Catalog output-token cap of the resolved model, when known. */
	maxOutputTokens?: number;
	/** Catalog context-window size (total tokens) of the resolved model, when known. */
	contextWindow?: number;
}

/**
 * Providers whose SDK path substitutes a small default `max_tokens` when the
 * request omits one, so they need an explicit budget even with no catalog cap.
 *
 * Exported for call sites that must NOT widen: a site which previously sent
 * no budget at all should only start sending one where omitting it is
 * actually harmful. Sending one everywhere reserves quota against TPM/OTPM
 * admission on providers that never had the problem.
 */
export function providerNeedsExplicitBudget(provider: string): boolean {
	return provider === "DATABRICKS" || provider === "ANTHROPIC_DIRECT";
}

/**
 * Shared clamping applied to both modes:
 *  1. Resolve the cap: the catalog output cap, else the gated fallback for
 *     providers that need an explicit budget, else `undefined` (no budget).
 *  2. Clamp the desired budget down to the cap. A cap below the floor sends
 *     exactly the cap — never over-asks and triggers a provider 400.
 *  3. If the context window is known, clamp again so `input + output` fits:
 *     leave room for the (conservatively estimated) prompt and a small margin.
 *     The clamp floors at 1, never at the margin — when the prompt already
 *     leaves ≤ 0 room the request cannot succeed on input size regardless of
 *     what we send, so requesting 1 keeps the failure honest (the provider
 *     rejects the oversized input) instead of manufacturing capacity that
 *     isn't there and compounding it with an over-ask.
 */
function clampToProviderAndContext(
	metadata: BudgetMetadata,
	desiredOutputTokens: number,
	promptChars: number,
): number | undefined {
	const cap =
		metadata.maxOutputTokens ??
		(providerNeedsExplicitBudget(metadata.provider)
			? FALLBACK_OUTPUT_TOKEN_CAP
			: undefined);

	if (cap === undefined) {
		return undefined;
	}

	let budget = Math.min(desiredOutputTokens, cap);

	if (metadata.contextWindow) {
		const contextClamp = Math.max(
			1,
			metadata.contextWindow -
				Math.ceil(promptChars / CONTEXT_CLAMP_CHARS_PER_TOKEN) -
				CONTEXT_WINDOW_MARGIN_TOKENS,
		);
		budget = Math.min(budget, contextClamp);
	}

	return budget;
}

/**
 * Scaled mode — output tracks input.
 *
 * The desired budget is `max(floor, 2 * inputTokens + overhead)`, then clamped
 * to the provider cap and context window. `inputChars = 0` deliberately
 * degenerates to the floor (used by bounded summary sites whose output is
 * short but still exceeds the 4,096 Anthropic fallback).
 *
 * @param metadata Resolved model metadata (provider + optional catalog caps).
 * @param opts.inputChars Character length of the content whose size the output
 *   tracks (the document being rewritten, the text being extracted, …).
 * @param opts.promptChars Character length of the FULL prompt sent (system +
 *   user), used only for the context-window clamp.
 * @returns The `maxOutputTokens` to send, or `undefined` to omit it.
 */
export function computeScaledOutputTokenBudget(
	metadata: BudgetMetadata,
	opts: { inputChars: number; promptChars: number },
): number | undefined {
	const estimatedInputTokens = Math.ceil(opts.inputChars / CHARS_PER_TOKEN);
	const desiredOutputTokens = Math.max(
		MIN_OUTPUT_TOKEN_BUDGET,
		2 * estimatedInputTokens + OVERHEAD_TOKENS,
	);
	return clampToProviderAndContext(
		metadata,
		desiredOutputTokens,
		opts.promptChars,
	);
}

/**
 * Maximal mode — output ≫ input.
 *
 * Requests the largest QUOTA-SAFE allowance: `ceilingTokens` (default
 * {@link MAXIMAL_OUTPUT_TOKEN_CEILING}) clamped to the catalog output cap when
 * known, else the gated fallback for providers that need an explicit budget,
 * else `undefined`. Deliberately NOT the model's full catalog cap — providers
 * that reserve the requested `max_tokens` against TPM/OTPM admission would
 * 429 under ordinary deployment quotas (see the ceiling's doc comment). The
 * result is still clamped to the context window so a long prompt reserves
 * room for its input.
 *
 * @param metadata Resolved model metadata (provider + optional catalog caps).
 * @param opts.promptChars Character length of the FULL prompt sent (system +
 *   user), used only for the context-window clamp.
 * @param opts.ceilingTokens Optional override for sites whose output genuinely
 *   exceeds the default ceiling — raising it raises the caller's quota
 *   reservation on TPM-admission providers, so opt in deliberately.
 * @returns The `maxOutputTokens` to send, or `undefined` to omit it.
 */
export function computeMaxOutputTokenBudget(
	metadata: BudgetMetadata,
	opts: { promptChars: number; ceilingTokens?: number },
): number | undefined {
	return clampToProviderAndContext(
		metadata,
		opts.ceilingTokens ?? MAXIMAL_OUTPUT_TOKEN_CEILING,
		opts.promptChars,
	);
}
