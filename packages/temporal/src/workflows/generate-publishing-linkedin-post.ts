/**
 * Fire-and-forget workflow that drafts the LinkedIn post options for ONE
 * publishing topic (Fizzy #1851).
 *
 * Started (not awaited) by `publishingSuite.generateLinkedInPost`. The caller
 * uses a deterministic, reject-duplicates workflowId
 * (`publishing-topic-li:<draftId>`) so concurrent clicks cannot double-spend the
 * LLM call — the draft id is already unique per attempt, and the partial unique
 * index on `status = 'GENERATING'` per content type is what makes only one
 * attempt exist.
 *
 * DEGRADATION BOUNDARY — this workflow never throws out to the caller. Nobody is
 * awaiting it, so a thrown error would be invisible AND would strand the row on
 * GENERATING, where it holds the partial unique index until the deadline sweep
 * reclaims it: ten minutes during which the button visibly does nothing. Every
 * failure path flips the row to FAILED, which the tab renders as an error plus a
 * retry. Same contract as `generate-publishing-short-post.ts`.
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

const { generateLinkedInPostActivity } = proxyActivities<typeof activities>({
	// Provenance-scoped reads, up to 20 GitHub PR fetches, and one COMPLEX-tier
	// LLM call over a long prompt.
	startToCloseTimeout: "480s",
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
// inherit the generous generation timeout, or a failing run stays GENERATING
// for another eight minutes.
const { markLinkedInPostFailedActivity } = proxyActivities<typeof activities>({
	startToCloseTimeout: "30s",
	retry: { maximumAttempts: 3 },
});

export interface GeneratePublishingLinkedInPostWorkflowInput {
	draftId: string;
	topicId: string;
	projectId: string;
	organizationId: string | null;
	actorUserId: string;
	guidance: string | null;
	/**
	 * The topic's saved working LinkedIn post when this run REFINES it rather
	 * than drafting fresh (Fizzy #1851, A7).
	 *
	 * OPTIONAL, and passed straight through with no branch around it. A history
	 * recorded before this field existed replays with it absent, which the
	 * activity reads as an ordinary generation — and because nothing here
	 * BRANCHES on it, the command sequence is identical either way and replay
	 * cannot see the difference.
	 */
	currentDraft?: string | null;
}

export interface GeneratePublishingLinkedInPostWorkflowOutput {
	status: "READY" | "FAILED" | "SUPERSEDED";
}

export async function generatePublishingLinkedInPostWorkflow(
	input: GeneratePublishingLinkedInPostWorkflowInput,
): Promise<GeneratePublishingLinkedInPostWorkflowOutput> {
	try {
		const result = await generateLinkedInPostActivity({
			draftId: input.draftId,
			topicId: input.topicId,
			projectId: input.projectId,
			organizationId: input.organizationId,
			actorUserId: input.actorUserId,
			guidance: input.guidance,
			currentDraft: input.currentDraft ?? null,
		});

		// A non-READY status is a normal outcome, not a failure. The write was
		// refused — usually because a deadline sweep reclaimed this attempt and
		// a newer one owns the content type.
		// Marking it FAILED would be a write to a row this run no longer owns:
		// the CAS would refuse it, and the log line would be untrue.
		//
		// The STATUS is deliberately "SUPERSEDED" for every refusal, matching
		// the rest of the family. Renaming it would change a branch condition,
		// and an execution already in flight would replay against a history that
		// says "SUPERSEDED", take the other branch, and issue a command the
		// history does not contain (TMPRL1100). So the honest part travels as
		// `refusalReason`, an OPTIONAL field absent on any older history.
		if (result.status === "SUPERSEDED") {
			log.info("[publishing-linkedin-post] attempt did not commit", {
				draftId: input.draftId,
				topicId: input.topicId,
				reason: result.refusalReason ?? "unknown",
			});
			return { status: "SUPERSEDED" };
		}

		return { status: "READY" };
	} catch (error) {
		// Two audiences. `message` is authored by us and is what the panel
		// renders to anyone who can see the tab; `detail` is the real unwrapped
		// reason and goes only to the log. Temporal's `ActivityFailure.message`
		// is the generic "Activity task failed", so reading it stored those four
		// words on every failed draft in the suite — and walking to the real
		// cause without this split would instead render whatever a provider or a
		// driver happened to say. See `publishing-failure-message.ts`.
		const { message, errorClass, detail } = publishingFailureDetail(error);
		log.error("[publishing-linkedin-post] generation failed", {
			errorClass,
			detail,
			draftId: input.draftId,
			topicId: input.topicId,
			message,
		});

		try {
			await markLinkedInPostFailedActivity({
				draftId: input.draftId,
				projectId: input.projectId,
				message,
			});
		} catch (markError) {
			// The row stays GENERATING until the deadline sweep reclaims it, and
			// the client's poll budget will time it out first. Nothing further
			// this workflow can do — but it must still not throw, or the failure
			// is recorded twice and read as a crash.
			log.error(
				"[publishing-linkedin-post] could not mark draft failed",
				{
					draftId: input.draftId,
					message:
						markError instanceof Error
							? markError.message
							: "Unknown error",
				},
			);
		}

		return { status: "FAILED" };
	}
}
