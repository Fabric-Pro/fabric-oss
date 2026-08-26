/**
 * Publishing Suggestion — byte-bound guard for collector activity results (H3).
 *
 * `PER_SOURCE_CAP` (packages/database/src/publishing-suite-schema.ts) bounds row
 * *count*, not serialized *bytes*: a handful of long transcript summaries or
 * PR/release bodies can still push a collector's return past Temporal's ~4MB
 * gRPC payload limit and fail the activity deterministically (the #1741 /
 * #1750 failure class). Every collector byte-bounds its `items` **before
 * returning** (the return value crosses into workflow history).
 *
 * Reuses the #1750 `boundGatheredData` helper (template-instance report
 * activities) rather than a bespoke truncation routine — same re-measuring
 * cascade (deep string truncation → largest-array cap → largest-key drop)
 * which never zeroes a data-bearing payload.
 */

import { boundGatheredData } from "../../template-instance/gathered-data-budget";

// 5 sources × 300KB ≈ 1.5MB — the ceiling the #1750 gathered-data guard uses,
// comfortably under Temporal's ~2MiB→4MB gRPC payload limit.
export const PER_SOURCE_MAX_BYTES = 300_000;

/**
 * Bound a collector's `items` array to `maxBytes` of serialized JSON before the
 * activity returns. `data` is the trimmed object; `trimmed` tells the caller
 * whether truncation happened at all. Surfacing `trimmed` lets each collector
 * treat a byte-truncation as source incompleteness (→ `capExhausted`, → no
 * coverage advance) instead of silently dropping context.
 */
export function byteBoundItems<T>(
	items: T[],
	maxBytes = PER_SOURCE_MAX_BYTES,
): { items: T[]; trimmed: boolean } {
	const { data, trimmed } = boundGatheredData(
		{ items } as Record<string, unknown>,
		{
			maxBytes,
		},
	);
	return {
		items: (Array.isArray(data.items) ? data.items : []) as T[],
		trimmed,
	};
}

/**
 * Publishing Suggestion — aggregate context-size guard (Codex round-2 N1).
 *
 * `PER_SOURCE_MAX_BYTES` bounds each of the (up to) 5 collectors
 * individually, but nothing bounded the TOTAL context the workflow hands to
 * `buildTopicSuggestionPrompt`. A busy project with all 5 sources near their
 * per-source cap can still assemble a ~1.5MB prompt (~400K tokens at ~4
 * chars/token) — enough to overflow the COMPLEX model's context window and
 * fail the whole cycle, even though every individual collector behaved.
 *
 * 75,000 tokens × ~4 chars/token ≈ 300,000 bytes. That is comfortably under
 * the smallest COMPLEX-tier model context window in use (128K-token class
 * models are the floor), leaving headroom for the rest of the prompt
 * (instructions in `buildTopicSuggestionPrompt`, ~1-2K tokens) plus the
 * model's output tokens (topics are short — title/pitch/provenance — but
 * still need budget). `getAIModelWithMetadata`'s `AIModelMetadata` does not
 * expose a context-window/token-limit field today (see
 * `packages/ai/lib/dynamic-model-selector.ts`), so this is a fixed,
 * model-agnostic ceiling rather than a per-model computed one — deliberately
 * conservative over precise.
 */
export const TOTAL_CONTEXT_MAX_BYTES = 300_000;

/**
 * Bound the WHOLE collector context (all source keys combined) to
 * `maxBytes` of serialized JSON before it is handed to
 * `buildTopicSuggestionPrompt`. Reuses the same `boundGatheredData` cascade
 * as `byteBoundItems` — truncate long strings, then cap the largest
 * top-level arrays, then drop the largest top-level keys — applied across
 * ALL source keys (`stories`, `documents`, `transcripts`, `pullRequests`,
 * `releases`) together rather than one array at a time.
 *
 * Each collector already returns items recency-DESC (newest first), and
 * `boundGatheredData`'s array-capping stage removes from the TAIL of the
 * largest array — so bounding the aggregate context naturally keeps the
 * newest items across all sources without a separate decay/ranking pass
 * (the 30-day soft-decay ranking (Q8) remains deferred to 1C).
 */
export function boundContextToBudget(
	context: Record<string, unknown>,
	maxBytes = TOTAL_CONTEXT_MAX_BYTES,
): { context: Record<string, unknown>; trimmed: boolean } {
	const result = boundGatheredData(context, { maxBytes });
	return { context: result.data, trimmed: result.trimmed };
}
