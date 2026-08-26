/**
 * Fire-and-forget workflow that auto-analyzes a freshly-ingested monitored
 * meeting transcript and (on ≥1 proposed change) creates a
 * `PendingBacklogProposal` in the unified Feature Proposals inbox.
 *
 * Started (not awaited) from inside the `fetchAndStoreMeetingTranscript`
 * activity right after a brand-new transcript record is created, when BOTH the
 * `meetingTranscriptSyncEnabled` and `meetingTranscriptAutoAnalyzeEnabled`
 * project flags are ON. The caller uses a deterministic, reject-duplicates
 * workflowId (`auto-analyze-meeting-transcript:<transcriptRecordId>`) so two
 * starts for the same transcript cannot both run.
 *
 * Intentionally trivial: one retried activity call, no signals/queries. Moving
 * analysis here (vs running it inline in the ingest activity) decouples the
 * ~300s LLM latency + retries from the 10-min ingest `startToCloseTimeout` and
 * keeps a failing analysis from re-running the whole ingest.
 *
 * It does NOT alter `meetingTranscriptSyncWorkflow`. The terminal-failure
 * marker added below is gated behind `patched()` so in-flight executions keep
 * their original command sequence on replay. No `Date.now()` / `Math.random()` /
 * IO runs in the workflow; all side effects live in the proxied activities.
 *
 * IMPORTANT: This file runs in Temporal's sandboxed V8 isolate. It may only
 * import from `@temporalio/workflow` and TYPE-ONLY from activity modules. No
 * `@repo/database` / `@repo/ai` / helper-package imports.
 */

import { patched, proxyActivities } from "@temporalio/workflow";
import type * as activities from "../activities";

const { autoAnalyzeMeetingTranscriptActivity } = proxyActivities<
	typeof activities
>({
	// The analyzer itself can run ~300s; give the activity headroom.
	startToCloseTimeout: "300s",
	heartbeatTimeout: "2 minutes",
	retry: {
		initialInterval: "10s",
		backoffCoefficient: 2,
		maximumInterval: "2m",
		maximumAttempts: 3,
		nonRetryableErrorTypes: ["ValidationError", "TenantViolation"],
	},
});

// Tiny terminal-failure marker — short timeout, a few quick retries. Runs only
// AFTER the analyze activity above has exhausted its own retries, to record a
// FAILED scan-status on the transcript.
const { markMeetingTranscriptAnalysisFailedActivity } = proxyActivities<
	typeof activities
>({
	startToCloseTimeout: "30s",
	retry: {
		initialInterval: "2s",
		backoffCoefficient: 2,
		maximumAttempts: 3,
	},
});

export interface AutoAnalyzeMeetingTranscriptWorkflowInput {
	projectId: string;
	userId: string;
	organizationId?: string;
	transcriptRecordId: string;
	contextId: string;
	meetingId: string;
	transcriptId: string;
	linkedMeetingId: string;
	meetingSubject: string;
	meetingDate?: string;
	transcriptText: string;
	/** #1814 FR7 — see the matching field on `AutoAnalyzeMeetingTranscriptInput`. */
	userInitiated?: boolean;
}

export interface AutoAnalyzeMeetingTranscriptWorkflowOutput {
	success: boolean;
	pendingProposalId?: string;
	changeCount: number;
	skippedReason?: string;
}

export async function autoAnalyzeMeetingTranscriptWorkflow(
	input: AutoAnalyzeMeetingTranscriptWorkflowInput,
): Promise<AutoAnalyzeMeetingTranscriptWorkflowOutput> {
	try {
		return await autoAnalyzeMeetingTranscriptActivity(input);
	} catch (err) {
		// The analyze activity exhausted its retries. Record a terminal FAILED
		// status on the transcript so the scan-status view shows "Failed" instead
		// of it silently looking unscanned, then complete this fire-and-forget
		// workflow cleanly rather than surfacing as a failed workflow with no
		// observable cause.
		//
		// Gated behind patched() so an execution started before this change keeps
		// its original (single-activity) command sequence on replay.
		if (patched("meeting-auto-analyze-failed-status-v1")) {
			const message = err instanceof Error ? err.message : String(err);
			await markMeetingTranscriptAnalysisFailedActivity({
				transcriptRecordId: input.transcriptRecordId,
				projectId: input.projectId,
				error: message,
			});
			return {
				success: false,
				changeCount: 0,
				skippedReason: "analysis_failed",
			};
		}
		throw err;
	}
}
