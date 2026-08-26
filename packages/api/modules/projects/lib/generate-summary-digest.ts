/**
 * Logic Summary digest generation (Feature Maturation V2, §10.1 / AC-3.x).
 *
 * The Summary & Questions tab opens with an always-current, scannable overview of
 * the feature — its core logic, key requirements, and significant decisions. That
 * digest is a *derived view* of the Clean Spec (`description` + `acceptanceCriteria`),
 * which fits the spec-as-source-of-truth model: the spec is canonical, the digest
 * is regenerated from it.
 *
 * This module is the model half (produce the digest string). Storing it
 * (`setSummaryDigest`) and deciding WHEN to (re)generate live in the seed
 * orchestrator. Writing only `summaryDigest` keeps this PM-sync isolated (§7.7):
 * the dev-facing Clean Spec is never touched.
 */

import { getLockedAttachmentRulesClause } from "@repo/agent-prompts";
import { generateObject, getAIModelWithMetadata } from "@repo/ai";
import { getProjectFunctionTagClause } from "@repo/ai/lib/function-tag-context";
import {
	type FeatureMaturationState,
	getBoundPromptForAgent,
	type MaturationTenantFilter,
} from "@repo/database";
import { combineCleanSpec } from "@repo/utils/clean-spec-content";
import { zodSchema } from "ai";
import { z } from "zod";

/** Agent key + document type for the (org-editable) Logic Summary prompt (#4a). */
const SUMMARY_PROMPT_AGENT = "maturation_summary";
const SUMMARY_PROMPT_DOCUMENT_TYPE = "GENERAL";

/** Work-item kind the summary prompt is resolved for (exact-match binding, #R2). */
export type SummaryStoryKind = "FEATURE" | "BUG";

const SummaryDigestSchema = z.object({
	summary: z
		.string()
		.describe(
			"A concise, scannable high-level overview of the feature: its core logic, key requirements, and any significant decisions or constraints. A few short paragraphs or tight bullet points — NOT a full spec.",
		),
});

/**
 * Default instruction text for the digest, used when no `maturation_summary`
 * prompt is bound for the tenant. Mirrors the PO's AC: high-level and scannable,
 * never a second copy of the spec, and free of working notes / intermediate AI
 * reasoning. An org can override this via the Prompt Library to bias the summary
 * toward the requirement areas it cares about (#4a).
 */
const DEFAULT_SUMMARY_INSTRUCTIONS = `You are writing a short, high-level summary of a feature specification for a product owner to scan in seconds. Capture the feature's core logic, its key requirements, and any significant decisions or constraints.

Rules:
- Keep it concise and scannable — a few short paragraphs or tight bullet points.
- Do NOT reproduce the full specification, restate every acceptance criterion, or expand it.
- Do NOT include working notes, open questions, or any intermediate AI reasoning — only the settled, high-level picture.
- Write in plain, direct prose. No preamble like "This feature…"; just the summary.`;

/**
 * Resolve the Logic Summary instruction text for a tenant: the bound
 * `maturation_summary` prompt when present and non-empty, else the built-in
 * default. Exposed so the seed orchestrator can fold it into the regeneration
 * hash — a prompt edit then forces a fresh summary on the next refresh (#4a).
 */
export async function resolveSummaryInstructions({
	tenantFilter,
	storyKind = "FEATURE",
}: {
	tenantFilter: MaturationTenantFilter;
	/** Resolves the kind-scoped Summary prompt (FEATURE vs BUG). Defaults to FEATURE. */
	storyKind?: SummaryStoryKind;
}): Promise<string> {
	const bound = await getBoundPromptForAgent({
		agentName: SUMMARY_PROMPT_AGENT,
		documentType: SUMMARY_PROMPT_DOCUMENT_TYPE,
		storyKind,
		userId: tenantFilter.userId,
		organizationId: tenantFilter.organizationId ?? undefined,
	});
	const content = bound?.version?.content?.trim();
	return content && content.length > 0
		? content
		: DEFAULT_SUMMARY_INSTRUCTIONS;
}

/**
 * Compose the full digest prompt from resolved instructions + the spec. Kept
 * separate from the instructions so the spec is never baked into the editable
 * prompt template.
 */
export function buildSummaryPrompt(instructions: string, spec: string): string {
	// FR-25: the shared locked-attachment rule —
	// dedicated attachments are read-only reference material the AI must never
	// fabricate or claim to have analysed. Kept here (not in the org-editable
	// `maturation_summary` prompt) so it holds regardless of prompt overrides.
	// No-op today (no attachment metadata reaches the spec); forward-compatible.
	return `${instructions}

${getLockedAttachmentRulesClause()}

FEATURE SPECIFICATION:
${spec}`;
}

export interface GenerateSummaryParams {
	feature: FeatureMaturationState;
	tenantFilter: MaturationTenantFilter;
	/**
	 * Resolved instruction text (from `resolveSummaryInstructions`). Optional — the
	 * caller resolves it once to fold into the regeneration hash and passes it here
	 * to avoid re-resolving. Falls back to resolving internally when omitted.
	 */
	instructions?: string;
}

/**
 * Generate the Logic Summary digest from a feature's Clean Spec. Returns `null`
 * when the spec is empty (nothing to summarize) or the model returns nothing.
 * Model resolution is tenant-coupled (usage limits enforced at resolution).
 */
export async function generateMaturationSummary({
	feature,
	tenantFilter,
	instructions,
}: GenerateSummaryParams): Promise<string | null> {
	const spec = combineCleanSpec(
		feature.description,
		feature.acceptanceCriteria,
	);
	if (!spec.trim()) {
		return null;
	}

	const resolvedInstructions =
		instructions ??
		(await resolveSummaryInstructions({
			tenantFilter,
			storyKind: feature.kind === "BUG" ? "BUG" : "FEATURE",
		}));

	const { model } = await getAIModelWithMetadata(
		{ taskType: "COMPLEX" },
		{
			userId: tenantFilter.userId,
			organizationId: tenantFilter.organizationId ?? undefined,
		},
	);

	// Fizzy #1767 Stage 4: append the project's function-tag role-composition
	// clause (flag-gated, self-authorizing — see getProjectFunctionTagClause)
	// so the model knows who's on the project and in what capacity. No-op
	// when the flag is off, or when no roster member holds a tag.
	const roleClause = feature.projectId
		? await getProjectFunctionTagClause({
				projectId: feature.projectId,
				requesterUserId: tenantFilter.userId,
				surface: "generate-summary-digest",
			})
		: "";

	const { object } = await generateObject({
		model,
		schema: zodSchema(SummaryDigestSchema),
		prompt:
			buildSummaryPrompt(resolvedInstructions, spec) +
			(roleClause ? `\n\n${roleClause}` : ""),
	});

	const summary = object.summary.trim();
	return summary === "" ? null : summary;
}
