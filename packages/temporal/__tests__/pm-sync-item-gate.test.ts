/**
 * Tests for the flat-PM-sync item gate (backlogApplyChangesWorkflow).
 *
 * The bug this fixes: after the DSU 2026-05-23 "story" retirement made
 * `feature` the primary leaf type, the legacy gate (only sync story/bug)
 * silently dropped every `feature` from flat PM tools (Fizzy, GitLab, Linear,
 * etc.). Now features sync as cards; only `epic` containers are skipped. The
 * legacy branch is preserved verbatim behind a `patched()` flag for replay
 * determinism.
 */

import { describe, expect, it } from "vitest";
import {
	type PmSyncItemType,
	shouldSkipFlatPmSync,
} from "../src/workflows/pm-sync-item-gate";

const ALL: PmSyncItemType[] = ["epic", "feature", "story", "bug"];

describe("shouldSkipFlatPmSync", () => {
	describe("hierarchical PM tool (Azure DevOps)", () => {
		it("never skips any type — the full hierarchy syncs", () => {
			for (const t of ALL) {
				expect(shouldSkipFlatPmSync(t, true, true)).toBe(false);
				expect(shouldSkipFlatPmSync(t, true, false)).toBe(false);
			}
		});
	});

	describe("flat PM tool, patched (current behavior)", () => {
		it("syncs feature/story/bug (NOT skipped) — this is the fix", () => {
			expect(shouldSkipFlatPmSync("feature", false, true)).toBe(false);
			expect(shouldSkipFlatPmSync("story", false, true)).toBe(false);
			expect(shouldSkipFlatPmSync("bug", false, true)).toBe(false);
		});

		it("skips only epic (a pure container with no flat-card equivalent)", () => {
			expect(shouldSkipFlatPmSync("epic", false, true)).toBe(true);
		});
	});

	describe("flat PM tool, NOT patched (legacy / replayed histories)", () => {
		it("preserves the old behavior: feature AND epic skipped, story/bug synced", () => {
			// This branch must match what recorded histories did, or replay
			// validation breaks (features issued no syncWorkItemToPM command).
			expect(shouldSkipFlatPmSync("feature", false, false)).toBe(true);
			expect(shouldSkipFlatPmSync("epic", false, false)).toBe(true);
			expect(shouldSkipFlatPmSync("story", false, false)).toBe(false);
			expect(shouldSkipFlatPmSync("bug", false, false)).toBe(false);
		});
	});

	it("regression: a feature on a flat tool is NO LONGER skipped once patched", () => {
		// The exact bug the user hit — features silently dropped from Fizzy.
		expect(shouldSkipFlatPmSync("feature", false, true)).toBe(false);
	});
});
