/**
 * Fire-and-forget workflow that produces the Planning & Analysis for ONE
 * publishing topic (Publishing Suite Phase 2A-2, Fizzy #1851).
 *
 * Started (not awaited) by `publishingSuite.generatePlanningAnalysis`. The
 * caller uses a deterministic, reject-duplicates workflowId
 * (`publishing-topic-pa:<analysisId>`) so concurrent clicks cannot double-spend
 * the LLM call — the analysis id is already unique per attempt, and the partial
 * unique index on `status = 'GENERATING'` is what makes only one attempt exist.
 *
 * DEGRADATION BOUNDARY — this workflow never throws out to the caller. Nobody is
 * awaiting it, so a thrown error would be invisible AND would strand the row on
 * GENERATING, where it holds the partial unique index until the deadline sweep
 * reclaims it: ten minutes during which the button visibly does nothing. Every
 * failure path flips the row to FAILED, which the tab renders as an error plus a
 * retry. Same contract as `generate-meeting-agenda.ts`.
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

const { generatePlanningAnalysisActivity } = proxyActivities<typeof activities>(
	{
		// Provenance-scoped reads, up to 20 GitHub PR fetches, and one
		// COMPLEX-tier LLM call over a long prompt.
		startToCloseTimeout: "480s",
		heartbeatTimeout: "2 minutes",
		retry: {
			initialInterval: "5s",
			backoffCoefficient: 2,
			maximumInterval: "1m",
			maximumAttempts: 3,
			nonRetryableErrorTypes: ["ValidationError", "TenantViolation"],
		},
	},
);

// Separate proxy: the failure marker is a single tiny write and must not
// inherit the generous generation timeout, or a failing run stays GENERATING
// for another eight minutes.
const { markPlanningAnalysisFailedActivity } = proxyActivities<
	typeof activities
>({
	startToCloseTimeout: "30s",
	retry: { maximumAttempts: 3 },
});

export interface GeneratePublishingPlanningAnalysisWorkflowInput {
	analysisId: string;
	topicId: string;
	projectId: string;
	organizationId: string | null;
	actorUserId: string;
}

export interface GeneratePublishingPlanningAnalysisWorkflowOutput {
	status: "READY" | "FAILED" | "SUPERSEDED";
}

export async function generatePublishingPlanningAnalysisWorkflow(
	input: GeneratePublishingPlanningAnalysisWorkflowInput,
): Promise<GeneratePublishingPlanningAnalysisWorkflowOutput> {
	try {
		const result = await generatePlanningAnalysisActivity({
			analysisId: input.analysisId,
			topicId: input.topicId,
			projectId: input.projectId,
			organizationId: input.organizationId,
			actorUserId: input.actorUserId,
		});

		// SUPERSEDED is a normal outcome, not a failure: a deadline sweep reclaimed
		// this attempt while the model ran and a newer one owns the topic. Marking
		// it FAILED would be a write to a row this run no longer owns — the CAS
		// would refuse it, and the log line would be untrue.
		if (result.status === "SUPERSEDED") {
			log.info("[publishing-planning] attempt superseded", {
				analysisId: input.analysisId,
				topicId: input.topicId,
			});
			return { status: "SUPERSEDED" };
		}

		return { status: "READY" };
	} catch (error) {
		const message =
			error instanceof Error ? error.message : "Unknown error";
		log.error("[publishing-planning] generation failed", {
			analysisId: input.analysisId,
			topicId: input.topicId,
			message,
		});

		try {
			await markPlanningAnalysisFailedActivity({
				analysisId: input.analysisId,
				projectId: input.projectId,
				message,
			});
		} catch (markError) {
			// The row stays GENERATING until the deadline sweep reclaims it, and
			// the client's poll budget will time it out first. Nothing further this
			// workflow can do — but it must still not throw, or the failure is
			// recorded twice and read as a crash.
			log.error("[publishing-planning] could not mark analysis failed", {
				analysisId: input.analysisId,
				message:
					markError instanceof Error
						? markError.message
						: "Unknown error",
			});
		}

		return { status: "FAILED" };
	}
}
