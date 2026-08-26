/**
 * The two automatic draft triggers, one per flow.
 *
 * Most cases here are a reason NOT to start a run, because drafting spends
 * model credits and nobody pressed a button. The expensive mistake is a missing
 * guard; a missing draft is a button away.
 *
 * The exception is the last block, which pins the property the two triggers
 * exist to provide: on any given project exactly one of them fires, so a
 * feature is drafted once and the "Apply TDD approach" switch chooses *when*
 * rather than *whether*.
 */

import { describe, expect, it } from "vitest";

import {
	shouldDraftAfterFeatureReview,
	shouldDraftOnReadyForDev,
} from "../auto-draft-test-cases";

/** A feature that has just reached Ready for Dev on a test-first project. */
const ready = {
	targetStage: "PUBLISHED",
	previousStage: "DRAFT",
	kind: "FEATURE",
	generateManualTestCases: true,
	applyTddApproach: true,
	existingCaseCount: 0,
	testCasesEnabled: true,
};

describe("shouldDraftOnReadyForDev", () => {
	it("drafts when a test-first feature reaches Ready for Dev", () => {
		expect(shouldDraftOnReadyForDev(ready)).toBe(true);
	});

	it("does nothing without the test-first switch", () => {
		// Not "drafting never happens" — the standard flow drafts too, just
		// later, after the feature review. This trigger is the test-first
		// moment specifically, so a project on the defaults must not fire it
		// here and then fire again after its review.
		expect(
			shouldDraftOnReadyForDev({ ...ready, applyTddApproach: false }),
		).toBe(false);
	});

	it("respects the generation switch", () => {
		// "Generate manual test cases" off means no drafting and no credits
		// spent discovering that — the same hard gate the button honours.
		expect(
			shouldDraftOnReadyForDev({
				...ready,
				generateManualTestCases: false,
			}),
		).toBe(false);
	});

	it("does nothing when the feature already has cases", () => {
		// Once per feature. Moving back to Draft and forward again is normal
		// while requirements settle, and each round trip must not re-bill. The
		// drafter's own dedupe runs AFTER the model call, so it would not have
		// prevented the spend.
		expect(
			shouldDraftOnReadyForDev({ ...ready, existingCaseCount: 3 }),
		).toBe(false);
	});

	it("does nothing when the stage did not actually change", () => {
		// Re-saving Ready for Dev is a no-op transition and must not bill.
		expect(
			shouldDraftOnReadyForDev({ ...ready, previousStage: "PUBLISHED" }),
		).toBe(false);
	});

	it("does nothing for any other stage", () => {
		for (const stage of ["DRAFT", "SANITY_CHECK", "DECLINED", "CLOSED"]) {
			expect(
				shouldDraftOnReadyForDev({ ...ready, targetStage: stage }),
			).toBe(false);
		}
	});

	it("does nothing for a bug", () => {
		// Bugs have no acceptance criteria to draft from, and the drafting
		// stages mean something different for them.
		expect(shouldDraftOnReadyForDev({ ...ready, kind: "BUG" })).toBe(false);
	});

	it("does nothing when the QA feature is off for the deployment", () => {
		expect(
			shouldDraftOnReadyForDev({ ...ready, testCasesEnabled: false }),
		).toBe(false);
	});
});

/** A feature whose review just completed on a project using the defaults. */
const reviewed = {
	kind: "FEATURE",
	generateManualTestCases: true,
	applyTddApproach: false,
	existingCaseCount: 0,
	testCasesEnabled: true,
};

describe("shouldDraftAfterFeatureReview", () => {
	it("drafts when a standard-flow feature has just been reviewed", () => {
		// The behaviour both the settings page and the Testing tab describe:
		// "cases are drafted after the feature is reviewed". Nothing observed
		// the review before, so on the DEFAULT settings no feature was ever
		// drafted automatically at all.
		expect(shouldDraftAfterFeatureReview(reviewed)).toBe(true);
	});

	it("does nothing under test-first", () => {
		// The cases already exist by now — they are what the review graded.
		// Drafting here would grade the model's own output.
		expect(
			shouldDraftAfterFeatureReview({
				...reviewed,
				applyTddApproach: true,
			}),
		).toBe(false);
	});

	it("respects the generation switch", () => {
		expect(
			shouldDraftAfterFeatureReview({
				...reviewed,
				generateManualTestCases: false,
			}),
		).toBe(false);
	});

	it("does nothing when the feature already has cases", () => {
		// Re-running a review is normal and must not re-bill.
		expect(
			shouldDraftAfterFeatureReview({
				...reviewed,
				existingCaseCount: 1,
			}),
		).toBe(false);
	});

	it("does nothing for a bug", () => {
		expect(
			shouldDraftAfterFeatureReview({ ...reviewed, kind: "BUG" }),
		).toBe(false);
	});

	it("does nothing when the QA feature is off for the deployment", () => {
		expect(
			shouldDraftAfterFeatureReview({
				...reviewed,
				testCasesEnabled: false,
			}),
		).toBe(false);
	});
});

describe("the two triggers together", () => {
	// The property the pair exists to provide, asserted by VARYING the switch
	// that chooses between them rather than holding it constant. Both flows
	// draft; the switch decides which moment does it. A regression that made
	// both fire would double-bill, and one that made neither fire is the bug
	// this whole module was written to close.
	it("fires exactly one trigger per project, whichever way the switch is set", () => {
		for (const applyTddApproach of [true, false]) {
			const atReadyForDev = shouldDraftOnReadyForDev({
				targetStage: "PUBLISHED",
				previousStage: "DRAFT",
				kind: "FEATURE",
				generateManualTestCases: true,
				applyTddApproach,
				existingCaseCount: 0,
				testCasesEnabled: true,
			});
			const afterReview = shouldDraftAfterFeatureReview({
				kind: "FEATURE",
				generateManualTestCases: true,
				applyTddApproach,
				existingCaseCount: 0,
				testCasesEnabled: true,
			});
			expect([atReadyForDev, afterReview]).toContain(true);
			expect(atReadyForDev && afterReview).toBe(false);
		}
	});

	it("fires neither when generation is switched off", () => {
		// The master switch. Off means no automatic run in either flow, which
		// is the "no credits spent" guarantee the setting makes.
		for (const applyTddApproach of [true, false]) {
			expect(
				shouldDraftOnReadyForDev({
					targetStage: "PUBLISHED",
					previousStage: "DRAFT",
					kind: "FEATURE",
					generateManualTestCases: false,
					applyTddApproach,
					existingCaseCount: 0,
					testCasesEnabled: true,
				}),
			).toBe(false);
			expect(
				shouldDraftAfterFeatureReview({
					kind: "FEATURE",
					generateManualTestCases: false,
					applyTddApproach,
					existingCaseCount: 0,
					testCasesEnabled: true,
				}),
			).toBe(false);
		}
	});
});
