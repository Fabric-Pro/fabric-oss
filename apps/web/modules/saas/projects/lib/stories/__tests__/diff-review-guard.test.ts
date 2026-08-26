import { describe, expect, it } from "vitest";
import {
	type StoryPropSyncGuardState,
	shouldDeferStoryPropSync,
} from "../diff-review-guard";

// Fizzy #1863 regression: after "Update Clean Spec", the inline diff sometimes
// flashed then vanished, and the "X decisions not added" banner never cleared.
// Root cause: StoryWorkspace Effect 5 (story prop → editor sync) rebuilt the
// editor from a background `stories.get` refetch while a `write_document_local`
// diff review was pending, wiping the derived diff and turning Accept into a
// no-op. This predicate is the guard that must defer that sync during a review.

const CALM: StoryPropSyncGuardState = {
	isAiLoading: false,
	isContextUpdateActive: false,
	isAwaitingConfirmation: false,
	hasPendingDiffMarks: false,
	hasUnsavedChanges: false,
};

describe("shouldDeferStoryPropSync", () => {
	it("allows the sync when nothing is in flight", () => {
		expect(shouldDeferStoryPropSync(CALM)).toBe(false);
	});

	it("defers while the copilot is streaming (isAiLoading)", () => {
		expect(shouldDeferStoryPropSync({ ...CALM, isAiLoading: true })).toBe(
			true,
		);
	});

	it("defers during the 'Update using context' diff (isContextUpdateActive)", () => {
		expect(
			shouldDeferStoryPropSync({ ...CALM, isContextUpdateActive: true }),
		).toBe(true);
	});

	// The two conditions the #1863 fix adds — the actual regression guards.
	it("defers while a confirm_changes review awaits accept/reject (#1863)", () => {
		expect(
			shouldDeferStoryPropSync({ ...CALM, isAwaitingConfirmation: true }),
		).toBe(true);
	});

	it("defers whenever the editor still carries pending diff marks (#1863)", () => {
		expect(
			shouldDeferStoryPropSync({ ...CALM, hasPendingDiffMarks: true }),
		).toBe(true);
	});

	it("mid-review a story.description refetch does NOT trigger a sync (the bug)", () => {
		// Exact bug shape: not streaming, not a context update, but a diff review
		// is open (awaiting confirmation + marks present) when `stories.get`
		// refetches. Pre-fix Effect 5 only checked isAiLoading/isContextUpdate and
		// rebuilt the editor here, destroying the diff. It must now defer.
		expect(
			shouldDeferStoryPropSync({
				isAiLoading: false,
				isContextUpdateActive: false,
				isAwaitingConfirmation: true,
				hasPendingDiffMarks: true,
				hasUnsavedChanges: false,
			}),
		).toBe(true);
	});

	// Effect 5 also destroyed *manual* edits. A background
	// `stories.get` refetch (refetchOnWindowFocus + staleTime 60s, or any of the
	// ~25 invalidateQueries calls in StoryWorkspace) rebuilt the editor from the
	// server prop, cleared the dirty flag and cancelled the pending autosave —
	// with no AI involvement at all. That is the reported "edits revert unless I
	// save frequently".
	it("defers while the user has unsaved manual edits (#1987)", () => {
		expect(
			shouldDeferStoryPropSync({ ...CALM, hasUnsavedChanges: true }),
		).toBe(true);
	});

	it("allows the sync once the editor is clean again (#1987)", () => {
		// After a successful save the mutation invalidates `stories.get`; the
		// refetch must be adopted normally, otherwise the editor would never
		// pick up server-side changes at all.
		expect(
			shouldDeferStoryPropSync({ ...CALM, hasUnsavedChanges: false }),
		).toBe(false);
	});
});
