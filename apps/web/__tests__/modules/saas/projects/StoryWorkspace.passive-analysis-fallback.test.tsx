import { DraftingStageIndicator } from "@saas/projects/components/stories/DraftingStageIndicator";
import type { FeatureDraftingStage } from "@saas/projects/lib/stories/types";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

// Spec: fabric/specs/2026-05-19-remove-passive-analysis/spec.md §12.2 test #4.
// "Pre-migration row renders cleanly (regression)."
//
// Intent: simulate a story / FeatureVersion row that retains the historical
// value `draftingStage = 'PASSIVE_ANALYSIS'` AFTER the spec has removed the
// stage from the local frontend type. The indicator must NOT throw, NOT log
// React errors, and MUST render `null` (no chip) per the graceful-degradation
// promise of OQ-2 + `DraftingStageIndicator.tsx:28-31` (`if (!meta) return null`).
//
// We test `DraftingStageIndicator` directly rather than the full
// `StoryWorkspace` because:
//   - StoryWorkspace is a heavy component with extensive ORPC + query-client
//     dependencies; rendering it in a unit test requires substantial mocking
//     that would obscure the invariant we care about.
//   - The fallback behavior lives entirely in DraftingStageIndicator (lines
//     28-31). Verifying it directly is the minimal, focused test.
//   - StoryWorkspace's own integration with this indicator is exercised by
//     the manual local verification in spec §11.3.6.

describe("StoryWorkspace — historical PASSIVE_ANALYSIS row fallback", () => {
	it("DraftingStageIndicator returns null for a historical PASSIVE_ANALYSIS stage", () => {
		// Cast through `unknown` because PASSIVE_ANALYSIS is no longer part
		// of the local `FeatureDraftingStage` union (post-G3 removal).
		// This simulates a stale row read from the DB where the Prisma-side
		// enum still includes PASSIVE_ANALYSIS (soft-deprecate per OQ-1).
		const staleStage =
			"PASSIVE_ANALYSIS" as unknown as FeatureDraftingStage;

		const { container } = render(
			<DraftingStageIndicator stage={staleStage} />,
		);

		// The component's null-fallback path returns null, which renders as
		// an empty container. No chip element should be present.
		expect(container.firstChild).toBeNull();
	});

	it("DraftingStageIndicator returns null in compact mode for PASSIVE_ANALYSIS", () => {
		const staleStage =
			"PASSIVE_ANALYSIS" as unknown as FeatureDraftingStage;

		const { container } = render(
			<DraftingStageIndicator stage={staleStage} compact />,
		);

		expect(container.firstChild).toBeNull();
	});

	it("DraftingStageIndicator does NOT throw for an unknown stage value", () => {
		// Defensive: simulate any other unrecognized enum value (e.g., a future
		// stage rolled back). The component should fail gracefully.
		const unknownStage = "TRIAGE" as unknown as FeatureDraftingStage;

		expect(() =>
			render(<DraftingStageIndicator stage={unknownStage} />),
		).not.toThrow();
	});

	it("DraftingStageIndicator still renders known stages (no regression)", () => {
		// Sanity check: PLACEHOLDER (a still-supported stage) should produce
		// a non-null render. This ensures the null fallback only fires for
		// genuinely-unknown stages.
		const { container } = render(
			<DraftingStageIndicator stage="PLACEHOLDER" />,
		);
		expect(container.firstChild).not.toBeNull();
	});
});
