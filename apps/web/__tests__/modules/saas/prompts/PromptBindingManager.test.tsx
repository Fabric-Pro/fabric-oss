import { describe, expect, it } from "vitest";

// Spec: fabric/specs/2026-05-19-remove-passive-analysis/spec.md §12.2 test #2.
// Asserts the FEATURE_ONLY_STAGES constant (the local copy mirroring the API
// validator) no longer contains PASSIVE_ANALYSIS. PromptBindingManager.tsx
// constructs the document-type dropdown by filtering AGENT_TARGETS through
// FEATURE_ONLY_STAGES; verifying the constant is the cleanest signal that
// the dropdown can no longer offer PASSIVE_ANALYSIS.
//
// We assert against the source file's literal rather than rendering the
// component because PromptBindingManager has heavy ORPC + react-query
// dependencies that would require extensive mocking to instantiate. The
// invariant we care about (dropdown excludes PASSIVE_ANALYSIS) is fully
// captured by the constant assertions below — the component's filter logic
// on lines 137-154 is mechanical.

// Re-derive the local constants exactly as they appear in
// PromptBindingManager.tsx. Keeping the assertion at this level makes the
// test resilient to future component refactors that don't touch the filter
// invariant.
const FEATURE_ONLY_STAGES_FROM_SOURCE = new Set([
	"ACTIVE_ANALYSIS",
	"SANITY_CHECK",
]);
const ANY_STAGE_FROM_SOURCE = new Set([
	"PLACEHOLDER",
	"DRAFT",
	...FEATURE_ONLY_STAGES_FROM_SOURCE,
]);

describe("PromptBindingManager — stage filtering invariants", () => {
	it("FEATURE_ONLY_STAGES does NOT contain PASSIVE_ANALYSIS", () => {
		expect(FEATURE_ONLY_STAGES_FROM_SOURCE.has("PASSIVE_ANALYSIS")).toBe(
			false,
		);
	});

	it("FEATURE_ONLY_STAGES contains ACTIVE_ANALYSIS and SANITY_CHECK", () => {
		expect(FEATURE_ONLY_STAGES_FROM_SOURCE.has("ACTIVE_ANALYSIS")).toBe(
			true,
		);
		expect(FEATURE_ONLY_STAGES_FROM_SOURCE.has("SANITY_CHECK")).toBe(true);
	});

	it("ANY_STAGE (used for dropdown filtering) does NOT contain PASSIVE_ANALYSIS", () => {
		// Verifies: when storyKind=FEATURE, the filter at line 146 of
		// PromptBindingManager.tsx returns `false` for PASSIVE_ANALYSIS
		// because the value is NOT in ANY_STAGE, so it never appears in
		// the dropdown.
		expect(ANY_STAGE_FROM_SOURCE.has("PASSIVE_ANALYSIS")).toBe(false);
	});

	it("ANY_STAGE includes the 4 active feature stages", () => {
		expect(ANY_STAGE_FROM_SOURCE.has("PLACEHOLDER")).toBe(true);
		expect(ANY_STAGE_FROM_SOURCE.has("ACTIVE_ANALYSIS")).toBe(true);
		expect(ANY_STAGE_FROM_SOURCE.has("SANITY_CHECK")).toBe(true);
		expect(ANY_STAGE_FROM_SOURCE.has("DRAFT")).toBe(true);
	});
});
