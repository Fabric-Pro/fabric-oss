import type { ChangeProposal } from "./analyze-context";

/**
 * Prepend final routed updates to nonblank summaries so clipped previews lead
 * with the routing note. Preserve blank summaries for the content-title fallback.
 */
export function addRoutingNoteToSummary(
	summary: string,
	changes: ChangeProposal["changes"],
): string {
	if (!summary.trim()) {
		return summary;
	}

	const enrichments = changes.filter(
		(change) =>
			change.action === "update" && change.routing?.decision === "enrich",
	);
	if (enrichments.length === 0) {
		return summary;
	}

	const identifiers = enrichments
		.map((change) => change.existingIdentifier)
		.filter((identifier): identifier is string => Boolean(identifier))
		.slice(0, 3);
	const remaining = enrichments.length - identifiers.length;
	if (identifiers.length > 0 && remaining > 0) {
		identifiers.push(`and ${remaining} more`);
	}
	const targets =
		identifiers.length > 0 ? ` (${identifiers.join(", ")})` : "";
	const note =
		enrichments.length === 1
			? `1 proposed item was matched to existing work item${targets} and will update it.`
			: `${enrichments.length} proposed items were matched to existing work items${targets} and will update them.`;
	return `${note}\n\n${summary}`;
}
