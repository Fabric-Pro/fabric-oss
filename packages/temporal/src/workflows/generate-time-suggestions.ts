/**
 * Fire-and-forget workflow that builds one member's time suggestions over a
 * range of work dates.
 *
 * Started (not awaited) by the API's one run starter, for
 * `timeTracking.generateSuggestions` and for the starts Fabric makes on its
 * own after a meeting, with a workflowId keyed to the run
 * (`time-suggestions:<runId>`). The run row's
 * partial unique index is what allows only one generating run per member and
 * organization; the page polls `timeTracking.suggestionStatus` until the run
 * leaves GENERATING.
 *
 * DEGRADATION BOUNDARY: this workflow never throws. Nobody awaits it, so a
 * thrown error would be invisible and would leave the run GENERATING until
 * the next start reclaims it. Every failure marks the run FAILED instead.
 * Drafting failing on its own is not a failure: the activity falls back to
 * plain descriptions.
 *
 * IMPORTANT: This file runs in Temporal's sandboxed V8 isolate. It may only
 * import from `@temporalio/workflow` and TYPE-ONLY from activity modules.
 *
 * REPLAY: v1 has one linear command sequence. Any later change that adds an
 * activity call or a new branch MUST be gated with `patched()`, or in-flight
 * executions fail replay with TMPRL1100.
 */

import { log, proxyActivities } from "@temporalio/workflow";
import type * as activities from "../activities";
import { AI_NON_RETRYABLE_ERROR_TYPES } from "./ai-non-retryable-errors";

const { collectTimeSuggestionCandidatesActivity } = proxyActivities<
	typeof activities
>({
	// A fortnight of one member's activity: a handful of indexed reads.
	startToCloseTimeout: "60s",
	retry: {
		initialInterval: "2s",
		backoffCoefficient: 2,
		maximumInterval: "30s",
		maximumAttempts: 3,
	},
});

const { draftTimeSuggestionsActivity } = proxyActivities<typeof activities>({
	// One SIMPLE-tier call over a short prompt; the activity itself falls back
	// rather than throwing when the model fails.
	startToCloseTimeout: "180s",
	retry: {
		initialInterval: "5s",
		backoffCoefficient: 2,
		maximumInterval: "1m",
		maximumAttempts: 2,
		nonRetryableErrorTypes: [...AI_NON_RETRYABLE_ERROR_TYPES],
	},
});

const { persistTimeSuggestionsActivity } = proxyActivities<typeof activities>({
	// One transaction of a few hundred small inserts at most.
	startToCloseTimeout: "60s",
	retry: {
		initialInterval: "2s",
		backoffCoefficient: 2,
		maximumInterval: "30s",
		maximumAttempts: 3,
	},
});

// Separate proxy: the failure marker is a single tiny write and must not
// inherit the drafting timeout.
const { markTimeSuggestionRunFailedActivity } = proxyActivities<
	typeof activities
>({
	startToCloseTimeout: "30s",
	retry: { maximumAttempts: 3 },
});

/** What the run row records for a failure; the cause goes to the log only. */
export const TIME_SUGGESTION_RUN_FAILED_MESSAGE =
	"Suggestions could not be generated. Try again.";

export interface GenerateTimeSuggestionsWorkflowInput {
	runId: string;
	organizationId: string;
	userId: string;
	fromDate: string;
	toDate: string;
	timezone: string;
	/** The projects the member could discover and log time on at the start. */
	projects: { id: string; name: string }[];
}

export interface GenerateTimeSuggestionsWorkflowOutput {
	status: "DONE" | "FAILED" | "SUPERSEDED";
	createdCount: number;
}

export async function generateTimeSuggestionsWorkflow(
	input: GenerateTimeSuggestionsWorkflowInput,
): Promise<GenerateTimeSuggestionsWorkflowOutput> {
	try {
		const candidates = await collectTimeSuggestionCandidatesActivity({
			organizationId: input.organizationId,
			userId: input.userId,
			fromDate: input.fromDate,
			toDate: input.toDate,
			timezone: input.timezone,
			projects: input.projects,
		});
		const drafts = await draftTimeSuggestionsActivity({
			organizationId: input.organizationId,
			userId: input.userId,
			timezone: input.timezone,
			candidates,
		});
		const result = await persistTimeSuggestionsActivity({
			runId: input.runId,
			organizationId: input.organizationId,
			userId: input.userId,
			timezone: input.timezone,
			candidates,
			drafts,
		});

		// Not stored because the run was reclaimed as timed out and a newer one
		// owns the member's slot. Marking it FAILED would write to a row this
		// run no longer owns.
		if (!result.persisted) {
			log.info("[time-suggestions] run did not commit", {
				runId: input.runId,
			});
			return { status: "SUPERSEDED", createdCount: 0 };
		}
		return { status: "DONE", createdCount: result.createdCount };
	} catch (error) {
		log.error("[time-suggestions] generation failed", {
			runId: input.runId,
			detail: error instanceof Error ? error.message : String(error),
		});

		try {
			await markTimeSuggestionRunFailedActivity({
				runId: input.runId,
				organizationId: input.organizationId,
				userId: input.userId,
				message: TIME_SUGGESTION_RUN_FAILED_MESSAGE,
			});
		} catch (markError) {
			// The run stays GENERATING until the next start reclaims it. The
			// workflow must still not throw.
			log.error("[time-suggestions] could not mark the run failed", {
				runId: input.runId,
				message:
					markError instanceof Error
						? markError.message
						: "Unknown error",
			});
		}

		return { status: "FAILED", createdCount: 0 };
	}
}
