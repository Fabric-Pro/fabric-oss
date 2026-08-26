/**
 * Cost math for Atlas smart-analysis telemetry.
 *
 * `costMicroUsd` is the AI spend of a run in micro-USD (1μ$ = $10^-6), the same
 * precise unit `AiUsageLog.costMicroUsd` stores so the two are summable. Rates
 * come from the model's `AiModel` row (`inputCostPer1M` / `outputCostPer1M`,
 * USD per 1,000,000 tokens), looked up by canonical name in `queries.ts`.
 *
 * Pure + dependency-free so the arithmetic is trivially unit-testable.
 */

export interface TokenTotals {
	promptTokens: number;
	completionTokens: number;
	totalTokens: number;
}

/** Zeroed token totals — the identity for {@link addTokenTotals}. */
export const EMPTY_TOKEN_TOTALS: TokenTotals = {
	promptTokens: 0,
	completionTokens: 0,
	totalTokens: 0,
};

/**
 * Normalise an AI-SDK usage object (`{ inputTokens, outputTokens, totalTokens }`,
 * any of which may be undefined) into {@link TokenTotals}. `totalTokens` falls
 * back to prompt+completion when the provider omits it.
 */
export function tokenTotalsFromUsage(
	usage:
		| {
				inputTokens?: number | null;
				outputTokens?: number | null;
				totalTokens?: number | null;
		  }
		| undefined
		| null,
): TokenTotals {
	const promptTokens = usage?.inputTokens ?? 0;
	const completionTokens = usage?.outputTokens ?? 0;
	const totalTokens = usage?.totalTokens ?? promptTokens + completionTokens;
	return { promptTokens, completionTokens, totalTokens };
}

/** Sum two token totals (used to accumulate usage across batched AI calls). */
export function addTokenTotals(a: TokenTotals, b: TokenTotals): TokenTotals {
	return {
		promptTokens: a.promptTokens + b.promptTokens,
		completionTokens: a.completionTokens + b.completionTokens,
		totalTokens: a.totalTokens + b.totalTokens,
	};
}

/**
 * Best-effort (B3) extraction of reasoning text from a generateObject result.
 * Different providers surface it as `reasoningText` (string) or `reasoning`
 * (string, or an array of `{ text }` parts). Returns null when absent — we never
 * spend effort here, so anything unexpected just yields null.
 */
export function extractReasoningText(result: unknown): string | null {
	if (!result || typeof result !== "object") {
		return null;
	}
	const r = result as { reasoningText?: unknown; reasoning?: unknown };
	if (typeof r.reasoningText === "string" && r.reasoningText.trim()) {
		return r.reasoningText.trim();
	}
	if (typeof r.reasoning === "string" && r.reasoning.trim()) {
		return r.reasoning.trim();
	}
	if (Array.isArray(r.reasoning)) {
		const text = r.reasoning
			.map((part) =>
				part && typeof part === "object" && "text" in part
					? String((part as { text: unknown }).text ?? "")
					: typeof part === "string"
						? part
						: "",
			)
			.join("")
			.trim();
		return text || null;
	}
	return null;
}

/** Join two optional reasoning blobs, dropping empties. */
export function concatReasoning(
	a: string | null,
	b: string | null,
): string | null {
	const parts = [a, b].filter((p): p is string => Boolean(p?.trim()));
	return parts.length ? parts.join("\n\n") : null;
}

/**
 * Compute cost in micro-USD from token counts and per-1M-token USD rates.
 *
 * USD = tokens / 1e6 * costPer1M, so micro-USD (×1e6) = tokens * costPer1M.
 * Mirrors `AiUsageLog.costMicroUsd` (rounded, never negative). A missing rate
 * (null) contributes 0 rather than throwing — telemetry must never fail a run.
 */
export function computeCostMicroUsd(args: {
	promptTokens: number;
	completionTokens: number;
	inputCostPer1M: number | null | undefined;
	outputCostPer1M: number | null | undefined;
}): number {
	const inputMicro = (args.promptTokens || 0) * (args.inputCostPer1M ?? 0);
	const outputMicro =
		(args.completionTokens || 0) * (args.outputCostPer1M ?? 0);
	return Math.max(0, Math.round(inputMicro + outputMicro));
}
