/**
 * Unified Search Formatting
 *
 * Formats unified search results for injection into LLM prompts,
 * with source attribution and badges for transparency.
 */

import { packPassageBlocks } from "../passage-packer";
import type { ProjectSearchResponse, UnifiedSearchResult } from "./types";

// Bounds the JSON-encoded Planner knowledge-search plan-step result carried
// into later prompts and the workflow payload, including wrappers and headers.
// Keep the 10,000-character allowance consistent with the project-context compactor.
const UNIFIED_SEARCH_RESULT_CHARS = 10_000;

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

	const blocks = response.results.map((result) => {
		const matched = Boolean(result.matchedPassages?.length);
		const project = result.source.type === "project-context";
		const summary = result.metadata?.isSummary === true;
		const referencesAt = summary
			? result.content.indexOf("SOURCE REFERENCES")
			: -1;
		const dividerAt =
			referencesAt >= 0
				? result.content.lastIndexOf("---", referencesAt)
				: -1;
		const splitAt = dividerAt >= 0 ? dividerAt : referencesAt;
		const body =
			splitAt >= 0
				? result.content.slice(0, splitAt).trimEnd()
				: result.content;
		const extent = project
			? matched
				? "Matched passages only.\n"
				: summary
					? "Showing the start of the summary.\n"
					: "Showing the start of the document.\n"
			: "";
		return {
			header: `--- [${result.source.badge}] ${formatSourceLabel(result)} (relevance: ${(result.relevance * 100).toFixed(1)}%) ---\n${result.contentHeader ?? ""}${extent}`,
			passages: result.matchedPassages?.length
				? result.matchedPassages
				: [{ content: body, score: result.relevance }],
			matched: true,
			references: splitAt >= 0 ? result.content.slice(splitAt) : "",
		};
	});
	const sourcesSummary = response.sourcesSearched
		.map((s) => `${s}: ${response.sourceCounts[s]}`)
		.join(", ");
	return packPassageBlocks(blocks, {
		maxChars: UNIFIED_SEARCH_RESULT_CHARS,
		prioritizeResultOrder: true,
		omittedNote: "\n[Content omitted to fit the result budget.]",
		render: (rendered, omittedBlocks) =>
			`<unified_search_results>\nSources searched: ${sourcesSummary} (${response.searchTimeMs}ms)\n\n${rendered.join("\n\n")}${omittedBlocks ? `\n[${omittedBlocks} source blocks omitted because their headers exceed the result budget; narrow the search to retrieve them.]` : ""}\n</unified_search_results>`,
		measure: (output) => JSON.stringify(output).length,
		metadataOverflow:
			"[Search metadata exceeds the result budget; narrow the search.]",
	});
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
