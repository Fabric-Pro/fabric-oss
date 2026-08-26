/**
 * Unified Search Formatting
 *
 * Formats unified search results for injection into LLM prompts,
 * with source attribution and badges for transparency.
 */

import type { ProjectSearchResponse, UnifiedSearchResult } from "./types";

/**
 * Format unified search results for LLM prompt injection.
 *
 * Each result includes source badge and attribution so the LLM
 * can cite sources accurately.
 */
export function formatUnifiedResultsForPrompt(
	response: ProjectSearchResponse,
): string {
	if (response.results.length === 0) {
		return "";
	}

	const formattedResults = response.results.map((result, _index) => {
		const sourceLabel = formatSourceLabel(result);
		const relevancePercent = (result.relevance * 100).toFixed(1);

		return `--- [${result.source.badge}] ${sourceLabel} (relevance: ${relevancePercent}%) ---\n${result.content}`;
	});

	const sourcesSummary = response.sourcesSearched
		.map((s) => `${s}: ${response.sourceCounts[s]}`)
		.join(", ");

	return `
<unified_search_results>
Sources searched: ${sourcesSummary} (${response.searchTimeMs}ms)

${formattedResults.join("\n\n")}
</unified_search_results>
`.trim();
}

/**
 * Format a single result for display (e.g. in a citation list).
 */
export function formatResultCitation(result: UnifiedSearchResult): string {
	const parts = [`[${result.source.badge}]`, result.source.name];

	if (result.source.url) {
		parts.push(`(${result.source.url})`);
	}

	if (result.source.freshness) {
		parts.push(`— ${result.source.freshness}`);
	}

	return parts.join(" ");
}

function formatSourceLabel(result: UnifiedSearchResult): string {
	if (result.source.filename) {
		return result.source.filename;
	}
	if (result.source.url) {
		try {
			return new URL(result.source.url).hostname;
		} catch {
			return result.source.name;
		}
	}
	return result.source.name;
}
