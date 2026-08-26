/**
 * Size and budget limits for Microsoft Teams tool responses.
 *
 * Every Teams tool in this package is expected to honor these caps so that
 * downstream LLM callers don't blow past model context windows. See
 * `extractRelevantExcerpts` for the query-aware path that drives most of
 * these limits, and `get_full_message` for the drill-down cap.
 */
export const TEAMS_TOOL_LIMITS = {
	/** Relevance-ranked excerpts returned per extractor pass. */
	EXCERPTS_PER_PASS: 8,
	/** Upper bound on the merged/dedup'd excerpt list from a two-pass search. */
	MAX_EXCERPTS_MERGED: 16,
	/** Per-excerpt char cap applied after LLM extraction (belt-and-suspenders). */
	MAX_CHARS_PER_EXCERPT: 400,
	/** Abort the extractor call if the LLM doesn't respond within this window. */
	EXTRACTOR_TIMEOUT_MS: 15_000,
	/**
	 * Hard cap on `get_full_message` response body. Without this, the agent
	 * can still overflow context by fanning out full-message reads across
	 * many messageIds surfaced by the extractor.
	 */
	FULL_MESSAGE_MAX_CHARS: 10_000,
} as const;
