import { ORPCError } from "@orpc/client";
import type { FeatureDraftingStage, StoryKind } from "@repo/database";

// Stages valid for each StoryKind:
// - PLACEHOLDER / DRAFT / PUBLISHED / DECLINED / CLOSED: shared.
// - ACTIVE_ANALYSIS / SANITY_CHECK: feature-only maturation pipeline. Bugs
//   skip these per F-171 (single-stage workflow).
//
// There are no bug-only stages. F-171 removed the prior TRIAGE value from
// FeatureDraftingStage; bugs progress PLACEHOLDER → DRAFT → CLOSED / DECLINED
// without a maturation gate. PASSIVE_ANALYSIS is soft-deprecated per spec
// 2026-05-19-remove-passive-analysis (enum value retained for historical-row
// safety, but no longer a feature-only stage).
export const FEATURE_ONLY_STAGES: ReadonlySet<FeatureDraftingStage> = new Set([
	"ACTIVE_ANALYSIS",
	"SANITY_CHECK",
]);

/**
 * Throws a 400 ORPCError if `stage` is not a valid drafting stage for `kind`.
 *
 * `FeatureDraftingStageSchema` accepts every enum value for every story,
 * because Prisma can only constrain the column itself, not a cross-column
 * rule. This helper layers the cross-column invariant on top so a stale
 * client can't, e.g., move a BUG story into `SANITY_CHECK`.
 */
export function validateStageForKind(
	stage: FeatureDraftingStage,
	kind: StoryKind,
): void {
	if (kind === "BUG" && FEATURE_ONLY_STAGES.has(stage)) {
		throw new ORPCError("BAD_REQUEST", {
			message: `Stage "${stage}" is not valid for a BUG story. Use one of PLACEHOLDER, DRAFT, PUBLISHED, DECLINED, or CLOSED.`,
		});
	}
}
