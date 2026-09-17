/**
 * Fire-and-forget workflow that refines ONE saved working draft (Fizzy #1851
 * follow-up).
 *
 * Started (not awaited) by `publishingSuite.refineDraft`. ONE workflow for all
 * seven content types, where generation needs seven — see
 * `refine-working-draft.ts` for why a refinement does not need to know what a
 * case study is.
 *
 * WORKFLOW ID is keyed on the RUN, not the topic: `publishing-refine:<runId>`.
 * Each claim mints a fresh run id, so a second refinement after a reclaim cannot
 * collide with a finished one's history — the same reasoning that keys the
 * generation workflows on the attempt id rather than the topic.
 *
 * DEGRADATION BOUNDARY — this workflow never throws out to the caller. Nobody is
 * awaiting it, so a thrown error would be invisible AND would strand the
 * proposal on GENERATING. Unlike its generation siblings, a stranded proposal
 * here does not hold a partial unique index: the next refine reclaims it as soon
 * as its deadline passes, and `refinementIsLive` is fail-OPEN on a missing
 * deadline. The failure marker still matters, because it is the difference
 * between the panel saying WHY the refinement failed and the panel saying
 * nothing for ten minutes.
 *
 * IMPORTANT: This file runs in Temporal's sandboxed V8 isolate. It may only
 * import from `@temporalio/workflow` and TYPE-ONLY from activity modules.
 *
 * REPLAY: v1 has one linear command sequence. Any later change that adds an
 * activity call or a new branch MUST be gated with `patched()` — otherwise
 * in-flight executions fail replay with TMPRL1100.
 */

import { log, proxyActivities } from "@temporalio/workflow";
import type * as activities from "../activities";
import { AI_NON_RETRYABLE_ERROR_TYPES } from "./ai-non-retryable-errors";
import { publishingFailureDetail } from "./publishing-failure-message";

const { refineWorkingDraftActivity } = proxyActivities<typeof activities>({
	// One COMPLEX-tier LLM call over a prompt carrying the whole draft. No
	// provenance reads and no PR fetches — a refinement revises the text in
	// hand rather than re-gathering what produced it — so the budget is
	// tighter than the generation family's 480s.
	startToCloseTimeout: "300s",
	heartbeatTimeout: "2 minutes",
	retry: {
		initialInterval: "5s",
		backoffCoefficient: 2,
		maximumInterval: "1m",
		maximumAttempts: 3,
		nonRetryableErrorTypes: [
			"ValidationError",
			"TenantViolation",
			...AI_NON_RETRYABLE_ERROR_TYPES,
		],
	},
});

// Separate proxy: the failure marker is a single tiny write and must not
// inherit the generous refinement timeout, or a failing run stays GENERATING
// for another five minutes.
const { markRefinementFailedActivity } = proxyActivities<typeof activities>({
	startToCloseTimeout: "30s",
	retry: { maximumAttempts: 3 },
});

export interface RefinePublishingDraftWorkflowInput {
	runId: string;
	topicId: string;
	projectId: string;
	postType:
		| "TWEET"
		| "LINKEDIN_POST"
		| "BLOG_POST"
		| "CASE_STUDY"
		| "STAKEHOLDER_EMAIL"
		| "WEBINAR_SCRIPT"
		| "NEWSLETTER_BLURB";
	organizationId: string | null;
	actorUserId: string;
	currentDraft: string;
	instruction: string | null;
}

export interface RefinePublishingDraftWorkflowOutput {
	status: "READY" | "FAILED" | "SUPERSEDED";
}

export async function refinePublishingDraftWorkflow(
	input: RefinePublishingDraftWorkflowInput,
): Promise<RefinePublishingDraftWorkflowOutput> {
	try {
		const result = await refineWorkingDraftActivity({
			runId: input.runId,
			topicId: input.topicId,
			projectId: input.projectId,
			postType: input.postType,
			organizationId: input.organizationId,
			actorUserId: input.actorUserId,
			currentDraft: input.currentDraft,
			instruction: input.instruction,
		});

		// A non-READY status is a normal outcome, not a failure. The write was
		// refused — the slot was reclaimed, rejected, or the project changed
		// tenant while the model was running. Marking it FAILED would be a write
		// to a slot this run no longer owns: the CAS would refuse it, and the
		// log line would be untrue.
		if (result.status === "SUPERSEDED") {
			log.info("[publishing-refine] run did not commit", {
				runId: input.runId,
				topicId: input.topicId,
				reason: result.refusalReason ?? "unknown",
			});
			return { status: "SUPERSEDED" };
		}

		return { status: "READY" };
	} catch (error) {
		// Two audiences. `message` is authored by us and is what the panel
		// renders; `detail` is the real unwrapped reason and goes only to the
		// log. Temporal's `ActivityFailure.message` is the generic "Activity
		// task failed", so reading it would store those four words on every
		// failed refinement. See `publishing-failure-message.ts`.
		const { message, errorClass, detail } = publishingFailureDetail(error);
		log.error("[publishing-refine] refinement failed", {
			errorClass,
			detail,
			runId: input.runId,
			topicId: input.topicId,
			message,
		});

		try {
			await markRefinementFailedActivity({
				runId: input.runId,
				topicId: input.topicId,
				projectId: input.projectId,
				postType: input.postType,
				message,
			});
		} catch (markError) {
			// The proposal stays GENERATING until its deadline passes, after
			// which the next refine reclaims it. Nothing further this workflow
			// can do — but it must still not throw, or the failure is recorded
			// twice and read as a crash.
			log.error("[publishing-refine] could not mark refinement failed", {
				runId: input.runId,
				message:
					markError instanceof Error
						? markError.message
						: "Unknown error",
			});
		}

		return { status: "FAILED" };
	}
}
