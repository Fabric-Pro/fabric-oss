/**
 * Diff-summary for the confirm-time review (Feature Maturation V2).
 *
 * The maturation run that the PO actually uses goes through the langgraph chat
 * agent (`write_document_local` → `confirm_changes`), which presents a full inline
 * diff (hundreds of hunks) before the PO accepts. This module turns the
 * before→after pair into a short, section-tagged change summary so the PO can
 * read ~4 lines instead of scanning the whole diff. Returns `[]` when there is no
 * meaningful change (or the model returns nothing).
 *
 * Read-only: never writes the spec, so PM-sync isolated (§7.7).
 */

import { getLockedAttachmentRulesClause } from "@repo/agent-prompts";
import { generateObject, getAIModelWithMetadata } from "@repo/ai";
import { getProjectFunctionTagClause } from "@repo/ai/lib/function-tag-context";
import type { MaturationTenantFilter } from "@repo/database";
import { zodSchema } from "ai";
import { z } from "zod";

const SpecChangeSummarySchema = z.object({
	changeSummary: z
		.array(z.string())
		.describe(
			"A reviewer-facing list of the substantive changes from the previous spec to the new one — 3 to 8 bullets, one per meaningful change, each ONE sentence prefixed with the affected section, e.g. 'Must Haves — restricted MFA methods to email and SMS'. Give additions and restructures EQUAL weight to removals — never a removal-only summary when the new version also adds or restructures content. Omit trivial wording/formatting tweaks. Empty array if nothing substantive changed.",
		),
});

// FR-25: the returned prompt embeds the shared
// locked-attachment rule (getLockedAttachmentRulesClause) between the summary
// rules and the two spec versions, so this read-only change digest never
// fabricates attachment contents. No-op today (no attachment metadata in spec).
export function buildChangeSummaryPrompt(
	before: string,
	after: string,
): string {
	return `Two versions of a feature specification follow: the PREVIOUS version and the NEW version the AI just produced. List the substantive changes the new version makes, for a product owner to review before accepting.

Rules:
- 3 to 8 bullets, one per meaningful change; each ONE sentence prefixed with the affected section (e.g. "Use Cases — added admin-only MFA disable").
- Describe only what MATERIALLY changed — new/removed/changed requirements, scope, business rules, decisions. Ignore pure wording, ordering, or formatting tweaks.
- Cover changes of ALL kinds — give ADDITIONS and RESTRUCTURES equal weight to removals. Do NOT return a removal-only summary when the new version also adds or restructures content.
- If the update restructures the document (e.g. a stage transition that rebuilds it into a new format), LEAD with that as the first bullet (e.g. "Document — restructured into a Sanity Check Go/No-Go summary"), then the most material content changes.
- Be concrete about the change itself, not "updated the X section".
- If nothing substantive changed, return an empty list.

${getLockedAttachmentRulesClause()}

PREVIOUS VERSION:
${before || "(empty)"}

NEW VERSION:
${after || "(empty)"}`;
}

export interface SummarizeSpecChangesParams {
	before: string;
	after: string;
	tenantFilter: MaturationTenantFilter;
	projectId: string;
}

/**
 * Summarize before→after into section-tagged change bullets. Returns `[]` when
 * the two versions are identical or the model produces nothing.
 */
export async function summarizeSpecChanges({
	before,
	after,
	tenantFilter,
	projectId,
}: SummarizeSpecChangesParams): Promise<string[]> {
	if (before.trim() === after.trim()) {
		return [];
	}

	const { model } = await getAIModelWithMetadata(
		{ taskType: "COMPLEX" },
		{
			userId: tenantFilter.userId,
			organizationId: tenantFilter.organizationId ?? undefined,
			featureKey: "maturation",
		},
	);

	// Fizzy #1767 Stage 4: append the project's function-tag role-composition
	// clause (flag-gated, self-authorizing — see getProjectFunctionTagClause)
	// so the model knows who's on the project and in what capacity. `projectId`
	// is required here; guard kept for uniformity with the other splice sites.
	const roleClause = projectId
		? await getProjectFunctionTagClause({
				projectId,
				requesterUserId: tenantFilter.userId,
				surface: "summarize-spec-changes",
			})
		: "";

	const { object } = await generateObject({
		model,
		schema: zodSchema(SpecChangeSummarySchema),
		prompt:
			buildChangeSummaryPrompt(before, after) +
			(roleClause ? `\n\n${roleClause}` : ""),
	});

	return object.changeSummary
		.map((b) => b.trim())
		.filter((b) => b.length > 0);
}
