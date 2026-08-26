/**
 * Fire-and-forget workflow that extracts meeting insights (summary, decisions,
 * action items, open questions) for a SINGLE transcript, on demand.
 *
 * Started (not awaited) by the `projects.meetingDigest.extractInsights`
 * procedure when a user opens a digest meeting whose insights cache is missing
 * or stale. The caller uses a deterministic, reject-duplicates workflowId
 * (`meeting-digest-insights:<transcriptRecordId>`) so concurrent opens of the
 * same meeting cannot double-spend the LLM call; the activity's own
 * insightsVersion cache guard makes a re-run after completion a no-op.
 *
 * Intentionally trivial — one retried activity call, no signals/queries — the
 * same shape as `autoAnalyzeMeetingTranscriptWorkflow`. No `Date.now()` /
 * `Math.random()` / IO in the workflow; all side effects live in the proxied
 * activity.
 *
 * IMPORTANT: This file runs in Temporal's sandboxed V8 isolate. It may only
 * import from `@temporalio/workflow` and TYPE-ONLY from activity modules.
 */

import { proxyActivities } from "@temporalio/workflow";
import type * as activities from "../activities";

const { extractMeetingInsightsActivity } = proxyActivities<typeof activities>({
	// One transcript, one LLM call — generous headroom over observed latency.
	startToCloseTimeout: "180s",
	heartbeatTimeout: "2 minutes",
	retry: {
		initialInterval: "5s",
		backoffCoefficient: 2,
		maximumInterval: "1m",
		maximumAttempts: 3,
		nonRetryableErrorTypes: ["ValidationError", "TenantViolation"],
	},
});

export interface ExtractMeetingInsightsOnDemandWorkflowInput {
	projectId: string;
	organizationId: string | null;
	userId: string;
	transcriptCuid: string;
	force?: boolean;
}

export interface ExtractMeetingInsightsOnDemandWorkflowOutput {
	extractedCount: number;
	cachedCount: number;
}

export async function extractMeetingInsightsOnDemandWorkflow(
	input: ExtractMeetingInsightsOnDemandWorkflowInput,
): Promise<ExtractMeetingInsightsOnDemandWorkflowOutput> {
	const result = await extractMeetingInsightsActivity({
		projectId: input.projectId,
		organizationId: input.organizationId,
		userId: input.userId,
		transcriptCuids: [input.transcriptCuid],
		// Rethrow LLM failures so the retry policy above actually engages —
		// the batch default swallows them, which would complete this workflow
		// with the cache still empty.
		failOnError: true,
		force: input.force,
	});
	return {
		extractedCount: result.extractedCount,
		cachedCount: result.cachedCount,
	};
}
