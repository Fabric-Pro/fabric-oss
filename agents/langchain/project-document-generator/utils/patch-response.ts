/**
 * Renderers for apply_document_patches result reporting.
 *
 * Dependency-free (type-only import) so chat-node tests can
 * `vi.importActual` the real implementations while the "../utils" barrel —
 * with its heavy model-factory imports — stays fully mocked (same pattern
 * as ./tool-rounds).
 */

import type { ReplaceTextStat } from "@repo/agent-prompts";

/** Quote a find string for messages, truncated to keep them readable. */
function quoteFind(find: string): string {
	return `"${find.slice(0, 60)}${find.length > 60 ? "…" : ""}"`;
}

/**
 * Render the ToolMessage content for a successful apply_document_patches
 * call. Beyond the base "Patches applied.", surfaces per-patch occurrence
 * counts for multi-occurrence (replaceAll) replacements and warns about
 * occurrences that survived outside an anchored search scope — so the model
 * can report an accurate summary and follow up on residuals instead of
 * silently under-replacing.
 */
export function buildPatchToolResponseContent(
	stats?: ReplaceTextStat[],
): string {
	const lines = ["Patches applied."];
	for (const stat of stats ?? []) {
		const find = quoteFind(stat.find);
		if (stat.occurrences > 1) {
			lines.push(
				`replace_text patch[${stat.patchIndex}] replaced ${stat.occurrences} occurrences of ${find}.`,
			);
		}
		if (stat.residualOccurrences > 0) {
			lines.push(
				`Note: ${stat.residualOccurrences} occurrence(s) of ${find} remain in the document (e.g. outside the anchored section). If the user meant those too, emit another replace_text patch for them.`,
			);
		}
	}
	return lines.join("\n");
}

/**
 * One-line user-facing note for the confirm card when replaceAll patches
 * touched multiple occurrences, so partial-vs-complete application is
 * visible without manually searching the document.
 */
export function buildReplaceAllFollowUpNote(
	stats?: ReplaceTextStat[],
): string | undefined {
	const totalReplaced = (stats ?? [])
		.filter((stat) => stat.replaceAll)
		.reduce((sum, stat) => sum + stat.occurrences, 0);
	if (totalReplaced <= 1) {
		return undefined;
	}
	return `Replaced ${totalReplaced} occurrences in total.`;
}
