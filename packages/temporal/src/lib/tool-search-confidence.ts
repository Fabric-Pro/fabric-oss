/** Shared routing cutoff for confidence on searchAvailableTools' 0–1 scale. */
export const STRONG_TOOL_MATCH_CONFIDENCE = 0.75;

const FALLBACK_TOOL_SEARCH_STRATEGIES: ReadonlySet<string> = new Set([
	"focused_server_fallback",
	"mentioned_server_fallback",
	"semantic_fallback_keyword",
]);

/** Whether retrieval returned an inventory or last-resort tool list. */
export function isFallbackToolSearchStrategy(strategy?: string): boolean {
	return FALLBACK_TOOL_SEARCH_STRATEGIES.has(strategy ?? "");
}

/**
 * Inventories and last-resort keyword results do not establish strong relevance,
 * even when their retrieval path assigns a confidence above the routing cutoff.
 */
export function isStrongToolMatch(result: {
	results: ReadonlyArray<{ confidence?: number }>;
	telemetry?: { strategy?: string };
}): boolean {
	if (isFallbackToolSearchStrategy(result.telemetry?.strategy)) {
		return false;
	}
	return result.results.some(
		(tool) => (tool.confidence ?? 0) >= STRONG_TOOL_MATCH_CONFIDENCE,
	);
}
