/**
 * When Fabric drafts a feature's test cases on its own.
 *
 * Both project switches describe an *order*, and each names the moment drafting
 * happens. This module owns both moments, so the two flows cannot drift apart:
 *
 *  - **Apply TDD approach ON** — cases are drafted straight after the
 *    requirements and *before* implementation. The moment is the feature
 *    reaching **Ready for Dev**.
 *  - **Apply TDD approach OFF** (the default) — cases are drafted *after* the
 *    feature review, from the finished specification. The moment is that
 *    review completing.
 *
 * Only the first of these was ever built. The standard flow's promise lived
 * purely in copy — the settings page and the feature's Testing tab both said
 * *"cases are drafted after the feature is reviewed"* while nothing observed the
 * review, so a project on the defaults never got an automatic case at all. The
 * two triggers are deliberately one module and one eligibility rule: a switch
 * that changes *when* work happens is not a switch that changes *whether* it
 * happens, and splitting them across files is how that distinction gets lost.
 *
 * **Ready for Dev is `FeatureDraftingStage.PUBLISHED`.** Finding that signal
 * mattered: `MaturationStatus` (TO_DO / DISCOVERY / DONE) looks like the
 * lifecycle and is decorative by its own schema comment, and Kanban statuses are
 * per-project user-defined columns that no code can safely match on by name.
 * `PUBLISHED` is the one stage that means "the requirements are done" for every
 * project, whatever they have named their columns.
 *
 * ## Why this is not a surprise charge
 *
 * Drafting spends model credits, and an automatic trigger that spends them
 * without anyone pressing a button deserves suspicion. Three things answer it:
 *
 *  - **"Generate manual test cases" is the master switch.** Off means no
 *    automatic run in either flow, whatever else is configured.
 *  - **Each flow fires at exactly one moment**, the one its switch already
 *    describes. Making the described behaviour real is fulfilling a promise the
 *    setting makes, not inventing a new one.
 *  - **It fires once per feature.** {@link isAutoDraftEligible} refuses when the
 *    feature already has cases, and the check happens BEFORE the claim, so a
 *    feature that moves back to Draft and forward again — or gets reviewed a
 *    second time — does not re-bill. The drafter's own dedupe runs after the
 *    model call and would not have prevented the spend.
 */

import { db } from "@repo/database";
import { logger } from "@repo/logs";
import { isTestCasesEnabled } from "@repo/utils/feature-flag";
import { startTestCaseDraft } from "./start-test-case-draft";

/** Ready for Dev, in the enum's own spelling. */
export const READY_FOR_DEV_STAGE = "PUBLISHED";

/** Which flow's moment fired, for the log line and nothing else. */
export type AutoDraftTrigger = "ready-for-dev" | "feature-review";

/** The conditions that hold for every automatic run, in either flow. */
type AutoDraftEligibility = {
	kind: string;
	/** The project's "Generate manual test cases" switch. */
	generateManualTestCases: boolean;
	/** Cases already linked to this feature. */
	existingCaseCount: number;
	/** Whether the QA feature is switched on for this deployment. */
	testCasesEnabled: boolean;
};

/**
 * Eligibility shared by both flows.
 *
 * Every condition here is a reason NOT to spend money, and the expensive
 * mistake is a missing guard rather than a missing draft.
 */
function isAutoDraftEligible(input: AutoDraftEligibility): boolean {
	return (
		input.testCasesEnabled &&
		// Bugs have no acceptance criteria to draft from, and the drafting
		// stages mean something different for them.
		input.kind === "FEATURE" &&
		input.generateManualTestCases &&
		// Once per feature. Reaching the moment twice is normal — requirements
		// settle, reviews get re-run — and each round trip must not cost another
		// generation.
		input.existingCaseCount === 0
	);
}

/**
 * Test-first: whether reaching Ready for Dev should start a drafting run.
 *
 * Exported and pure so the conditions are testable without a database.
 */
export function shouldDraftOnReadyForDev(
	input: AutoDraftEligibility & {
		/** The stage the feature just moved to. */
		targetStage: string;
		/** The stage it was on. Equal stages mean nothing actually transitioned. */
		previousStage: string;
		/** The project's "Apply TDD approach" switch. */
		applyTddApproach: boolean;
	},
): boolean {
	return (
		isAutoDraftEligible(input) &&
		input.targetStage === READY_FOR_DEV_STAGE &&
		// A no-op save must not bill. `updateStoryDraftingStage` is itself a
		// no-op when the stage is unchanged, and this mirrors that.
		input.previousStage !== READY_FOR_DEV_STAGE &&
		// This is the test-first moment specifically. Without the switch the
		// standard flow owns the drafting, and it happens later.
		input.applyTddApproach
	);
}

/**
 * Standard ordering: whether a completed feature review should start a run.
 *
 * The review is what the cases are drafted *from* in this flow, so its
 * completion is the moment — there is no earlier one, and no stage means
 * "reviewed". Deliberately the mirror image of
 * {@link shouldDraftOnReadyForDev}: exactly one of the two can fire for a given
 * project, because they disagree on `applyTddApproach`.
 */
export function shouldDraftAfterFeatureReview(
	input: AutoDraftEligibility & {
		/** The project's "Apply TDD approach" switch. */
		applyTddApproach: boolean;
	},
): boolean {
	return (
		isAutoDraftEligible(input) &&
		// Under test-first the cases already exist by now — they are what the
		// review graded. Drafting here would grade the model's own output.
		!input.applyTddApproach
	);
}

/**
 * Start the run, swallowing every failure.
 *
 * Fire-and-forget on purpose. Nobody pressed a button, so an error has no
 * surface to appear on, and failing the action that triggered this — a stage
 * transition, a review — because a drafting run could not start would be a worse
 * outcome than not drafting: that action is what the user actually asked for.
 */
export async function startAutoDraft(input: {
	projectId: string;
	organizationId: string | null;
	userId: string;
	storyId: string;
	trigger: AutoDraftTrigger;
}): Promise<void> {
	try {
		const result = await startTestCaseDraft({
			projectId: input.projectId,
			organizationId: input.organizationId,
			userId: input.userId,
			requestedById: input.userId,
			storyIds: [input.storyId],
		});
		if (result.started) {
			logger.info("qa.test_cases.auto_draft_started", {
				projectId: input.projectId,
				storyId: input.storyId,
				jobId: result.jobId,
				trigger: input.trigger,
			});
			return;
		}
		// A blocked claim is the normal concurrent case, not a fault: a run over
		// this feature is already in flight, which is exactly what we wanted.
		logger.info("qa.test_cases.auto_draft_skipped", {
			projectId: input.projectId,
			storyId: input.storyId,
			trigger: input.trigger,
			reason: result.reason,
		});
	} catch (error) {
		logger.warn("qa.test_cases.auto_draft_failed", {
			projectId: input.projectId,
			storyId: input.storyId,
			trigger: input.trigger,
			error: error instanceof Error ? error.message : String(error),
		});
	}
}

/**
 * Run the Ready-for-Dev trigger for a stage change, whichever procedure made it.
 *
 * Every procedure that moves a feature's `draftingStage` has to do this, and the
 * first attempt wired it into the two procedures that were known at the time.
 * That was the wrong layer: `stories.update` — the generic save the feature
 * editor's own stage dropdown posts to — and `stories.enhance` also write the
 * field, so a user picking "Ready for Dev" in the editor and pressing Save got
 * no drafting run at all. That is the same symptom the original report raised,
 * reached through a different door.
 *
 * So the decision lives here, in one function, and the callers pass only what
 * they already know. It loads its own eligibility snapshot rather than making
 * each caller select the right columns — a caller that forgets a column would
 * silently disable the trigger instead of failing.
 *
 * Fire-and-forget by design: the stage change is what the user asked for, and a
 * drafting run that cannot start must not fail their save.
 *
 * CALLERS MUST WRAP THIS IN `runInBackground`, never `void` it. Everything here
 * — including the eligibility query — runs after the caller stops awaiting, and
 * on Vercel a bare floating promise is not guaranteed to finish once the
 * response is sent (see `run-in-background.ts`). A `void`-ed call gets killed
 * mid-query often enough to look exactly like the bug this trigger exists to
 * fix: no run, no error, nothing in the log.
 */
export async function maybeAutoDraftOnStageChange(input: {
	projectId: string;
	storyId: string;
	userId: string;
	/** The stage before the write. Equal stages mean nothing transitioned. */
	previousStage: string | null | undefined;
	targetStage: string;
}): Promise<void> {
	// Cheap gates first: the overwhelming majority of stage changes are not a
	// move to Ready for Dev, and they must not cost a query.
	//
	// A null/undefined `previousStage` means the feature did not exist before —
	// it was CREATED at this stage. That still counts: the API accepts a stage
	// and acceptance criteria on create, so a feature can arrive at Ready for Dev
	// without ever transitioning, and it is eligible on every other condition.
	// Only an equal previous stage means nothing actually happened.
	if (
		!isTestCasesEnabled() ||
		input.targetStage !== READY_FOR_DEV_STAGE ||
		input.previousStage === input.targetStage
	) {
		return;
	}

	const existing = await db.userStory.findUnique({
		where: { id: input.storyId, projectId: input.projectId },
		select: {
			kind: true,
			project: {
				select: {
					// From the RECORD, never the request: the drafting run resolves
					// AI credentials and bills credits against whatever org it is
					// handed, and these procedures authorize `projectId` alone.
					organizationId: true,
					generateManualTestCases: true,
					applyTddApproach: true,
				},
			},
			_count: { select: { testCaseLinks: true } },
		},
	});
	if (!existing) {
		return;
	}

	if (
		!shouldDraftOnReadyForDev({
			targetStage: input.targetStage,
			// Creation has no previous stage; any value that is not the target
			// reads as "this is a real arrival" to the pure predicate.
			previousStage: input.previousStage ?? "",
			kind: existing.kind,
			generateManualTestCases:
				existing.project?.generateManualTestCases ?? false,
			applyTddApproach: existing.project?.applyTddApproach ?? false,
			existingCaseCount: existing._count.testCaseLinks,
			testCasesEnabled: isTestCasesEnabled(),
		})
	) {
		return;
	}

	await startAutoDraft({
		projectId: input.projectId,
		organizationId: existing.project?.organizationId ?? null,
		userId: input.userId,
		storyId: input.storyId,
		trigger: "ready-for-dev",
	});
}
