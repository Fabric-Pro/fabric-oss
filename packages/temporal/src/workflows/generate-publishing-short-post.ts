/**
 * Fire-and-forget workflow that drafts the Short Post / Tweet options for ONE
 * publishing topic (Publishing Suite Phase 2B-2, Fizzy #1853).
 *
 * Started (not awaited) by `publishingSuite.generateShortPost`. The caller uses
 * a deterministic, reject-duplicates workflowId (`publishing-topic-sp:<draftId>`)
 * so concurrent clicks cannot double-spend the LLM call — the draft id is
 * already unique per attempt, and the partial unique index on
 * `status = 'GENERATING'` per content type is what makes only one attempt exist.
 *
 * DEGRADATION BOUNDARY — this workflow never throws out to the caller. Nobody is
 * awaiting it, so a thrown error would be invisible AND would strand the row on
 * GENERATING, where it holds the partial unique index until the deadline sweep
 * reclaims it: ten minutes during which the button visibly does nothing. Every
 * failure path flips the row to FAILED, which the tab renders as an error plus a
 * retry. Same contract as `generate-publishing-planning-analysis.ts`.
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

const { generateShortPostActivity } = proxyActivities<typeof activities>({
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
const { markShortPostFailedActivity } = proxyActivities<typeof activities>({
	startToCloseTimeout: "30s",
	retry: { maximumAttempts: 3 },
});

export interface GeneratePublishingShortPostWorkflowInput {
	draftId: string;
	topicId: string;
	projectId: string;
	organizationId: string | null;
	actorUserId: string;
	guidance: string | null;
}

export interface GeneratePublishingShortPostWorkflowOutput {
	status: "READY" | "FAILED" | "SUPERSEDED";
}

export async function generatePublishingShortPostWorkflow(
	input: GeneratePublishingShortPostWorkflowInput,
): Promise<GeneratePublishingShortPostWorkflowOutput> {
	try {
		const result = await generateShortPostActivity({
			draftId: input.draftId,
			topicId: input.topicId,
			projectId: input.projectId,
			organizationId: input.organizationId,
			actorUserId: input.actorUserId,
			guidance: input.guidance,
		});

		// A non-READY status is a normal outcome, not a failure. The write was
		// refused — usually because a deadline sweep reclaimed this attempt and
		// a newer one owns the content type.
		// Marking it FAILED would be a write to a row this run no longer owns:
		// the CAS would refuse it, and the log line would be untrue.
		//
		// The STATUS is deliberately still "SUPERSEDED" for every refusal.
		// Renaming it would change a branch condition, and an execution already
		// in flight would replay against a history that says "SUPERSEDED", take
		// the other branch, and issue a command the history does not contain
		// (TMPRL1100). So the honest part travels as `refusalReason`, a new
		// OPTIONAL field — absent on any history recorded before it existed.
		if (result.status === "SUPERSEDED") {
			log.info("[publishing-short-post] attempt did not commit", {
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
		log.error("[publishing-short-post] generation failed", {
			errorClass,
			detail,
			draftId: input.draftId,
			topicId: input.topicId,
			message,
		});

		try {
			await markShortPostFailedActivity({
				draftId: input.draftId,
				projectId: input.projectId,
				message,
			});
		} catch (markError) {
			// The row stays GENERATING until the deadline sweep reclaims it, and
			// the client's poll budget will time it out first. Nothing further
			// this workflow can do — but it must still not throw, or the failure
			// is recorded twice and read as a crash.
			log.error("[publishing-short-post] could not mark draft failed", {
				draftId: input.draftId,
				message:
					markError instanceof Error
						? markError.message
						: "Unknown error",
			});
		}

		return { status: "FAILED" };
	}
}
