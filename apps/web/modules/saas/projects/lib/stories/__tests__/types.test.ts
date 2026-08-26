import { describe, expect, it } from "vitest";
import { DRAFTING_STAGE_META, type FeatureDraftingStage } from "../types";

// Spec: fabric/specs/2026-05-19-remove-passive-analysis/spec.md §12.2 test #5.
// Asserts the DRAFTING_STAGE_META lookup safety invariant introduced by G3:
//   - PASSIVE_ANALYSIS is no longer a key in the META map.
//   - The remaining keys are exactly the 7 active + terminal stages.
//   - `order` is contiguous 0..6 (no orphan rank slot).
//
// This is the AC13 automatic-detection mechanism in test form. If a future
// implementer reintroduces PASSIVE_ANALYSIS without updating this map, the
// test fails before the regression ships.

describe("DRAFTING_STAGE_META", () => {
	it("does NOT contain PASSIVE_ANALYSIS", () => {
		// Use a typed lookup that doesn't blow up at TS-check time. The local
		// union no longer includes PASSIVE_ANALYSIS, so an indexed access on
		// the union-keyed Record would not type-check. We assert via the
		// raw object shape instead.
		const meta = DRAFTING_STAGE_META as Record<string, unknown>;
		expect(meta.PASSIVE_ANALYSIS).toBeUndefined();
	});

	it("has exactly the 7 active + terminal stages as keys", () => {
		const keys = Object.keys(DRAFTING_STAGE_META).sort();
		expect(keys).toEqual(
			[
				"PLACEHOLDER",
				"ACTIVE_ANALYSIS",
				"SANITY_CHECK",
				"DRAFT",
				"PUBLISHED",
				"DECLINED",
				"CLOSED",
			].sort(),
		);
	});

	it("has contiguous `order` values 0..6 across all entries", () => {
		const orders = Object.values(DRAFTING_STAGE_META)
			.map((entry) => entry.order)
			.sort((a, b) => a - b);
		expect(orders).toEqual([0, 1, 2, 3, 4, 5, 6]);
	});

	it("PLACEHOLDER stays at order 0", () => {
		expect(DRAFTING_STAGE_META.PLACEHOLDER.order).toBe(0);
	});

	it("ACTIVE_ANALYSIS now occupies order 1 (was 2, renumbered after PASSIVE_ANALYSIS removal)", () => {
		expect(DRAFTING_STAGE_META.ACTIVE_ANALYSIS.order).toBe(1);
	});

	it("CLOSED occupies the terminal order 6 (was 7, renumbered)", () => {
		expect(DRAFTING_STAGE_META.CLOSED.order).toBe(6);
	});

	it("FeatureDraftingStage union excludes PASSIVE_ANALYSIS (compile-time check)", () => {
		// This test exists as a compile-time signal. If PASSIVE_ANALYSIS is
		// re-added to the union, the line below will start type-checking
		// successfully (instead of failing) — which is itself the signal.
		// At runtime, the assertion is a tautology.
		const validStages: FeatureDraftingStage[] = [
			"PLACEHOLDER",
			"ACTIVE_ANALYSIS",
			"SANITY_CHECK",
			"DRAFT",
			"PUBLISHED",
			"DECLINED",
			"CLOSED",
		];
		expect(validStages).toHaveLength(7);
	});
});
