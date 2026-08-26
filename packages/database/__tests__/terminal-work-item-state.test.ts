/**
 * Unit tests for the shared terminal-state predicate.
 *
 * `isTerminalWorkItemState` / `TERMINAL_DRAFTING_STAGES` are the single source
 * of truth for "this work item is a resolved, immutable record". They back the
 * AI-Update apply terminal-state gate (`applyBacklogChanges`) and, via
 * `INACTIVE_STAGES`, the duplicate-detection scan + the AI-Update dedup index.
 *
 * Pure logic, no DB — run with:
 *   pnpm --filter @repo/database test __tests__/terminal-work-item-state.test.ts
 */
import { describe, expect, it } from "vitest";
import { isTerminalWorkItemState, TERMINAL_DRAFTING_STAGES } from "../utils";

describe("TERMINAL_DRAFTING_STAGES", () => {
	it("is exactly the resolved/inactive stage set (DECLINED, CLOSED)", () => {
		// Pins the terminal stage list. `duplicate-links.ts` sources its
		// `INACTIVE_STAGES` from this constant, so the scan, the gate, and the
		// dedup index can never drift apart on what "terminal" means.
		expect([...TERMINAL_DRAFTING_STAGES].sort()).toEqual([
			"CLOSED",
			"DECLINED",
		]);
	});
});

describe("isTerminalWorkItemState", () => {
	// Truth table over draftingStage × pmAutoHidden. CLOSED and DECLINED are
	// terminal regardless of pmAutoHidden; pmAutoHidden forces terminal even on a
	// (data-model-impossible but defensively covered) non-terminal stage.
	it.each([
		// stage, pmAutoHidden, expected
		["CLOSED", false, true],
		["CLOSED", true, true],
		["DECLINED", false, true],
		["DECLINED", true, true],
		["DRAFT", false, false],
		["DRAFT", true, true], // pmAutoHidden clause (defensive)
		["PLACEHOLDER", false, false],
		["PUBLISHED", false, false], // PUBLISHED is final but NOT terminal/immutable for AI Update
		["PASSIVE_ANALYSIS", false, false],
		["ACTIVE_ANALYSIS", false, false],
		["SANITY_CHECK", false, false],
	] as const)(
		"draftingStage=%s pmAutoHidden=%s → terminal=%s",
		(draftingStage, pmAutoHidden, expected) => {
			expect(
				isTerminalWorkItemState({ draftingStage, pmAutoHidden }),
			).toBe(expected);
		},
	);
});
