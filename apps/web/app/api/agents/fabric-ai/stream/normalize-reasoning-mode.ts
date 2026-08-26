/**
 * The frontend Zod schema in `route.ts` accepts a user-facing union of
 * reasoning modes. The Temporal workflow input type and activity mode
 * mappings only understand a smaller backend vocabulary. This helper
 * is the single boundary point that collapses one onto the other.
 *
 * - "lite"      -> "lite"      (cheap/fast model selection)
 * - "balanced"  -> "balanced"  (default; medium complexity model)
 * - "deep"      -> "pro"       (reasoning-class model; thinking enabled)
 * - "planner"   -> "pro"       (planner flows also want reasoning models)
 *
 * Without this normalization the `as "pro"` cast at the workflow boundary
 * passes "deep" / "planner" strings into a switch that only matches "pro",
 * so those modes silently fall through to the default (medium) branch and
 * never trigger REASONING task selection.
 */
export type FrontendReasoningMode = "lite" | "balanced" | "deep" | "planner";
export type BackendReasoningMode = "lite" | "balanced" | "pro";

export function normalizeReasoningMode(
	mode: FrontendReasoningMode | undefined,
): BackendReasoningMode {
	switch (mode) {
		case "lite":
			return "lite";
		case "balanced":
			return "balanced";
		case "deep":
		case "planner":
			return "pro";
		default:
			return "balanced";
	}
}
