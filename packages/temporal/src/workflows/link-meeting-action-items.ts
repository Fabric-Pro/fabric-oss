/**
 * Fire-and-forget workflow that matches ONE meeting's action items to the
 * project's work items (#1902).
 *
 * Started (not awaited) by the `projects.meetingDigest.linkActionItems`
 * procedure once a meeting's insights are ready. The deterministic workflowId
 * (`meeting-action-item-links:<transcriptRecordId>`) plus a FAIL conflict policy
 * collapses concurrent opens of the same meeting, and the activity's own
 * `actionItemsLinkVersion` cache guard makes a re-run after completion a no-op.
 *
 * A NEW workflow rather than a step appended to
 * `extractMeetingInsightsOnDemandWorkflow`: adding an activity call to an
 * existing workflow changes its command sequence and breaks replay of in-flight
 * executions (TMPRL1100) unless gated behind `patched()`, and chaining would
 * also never reach meetings whose insights were extracted before this shipped.
 *
 * Intentionally trivial — one retried activity call, no signals or queries —
 * the same shape as `extractMeetingInsightsOnDemandWorkflow`. No `Date.now()` /
 * `Math.random()` / IO in the workflow; every side effect lives in the activity.
 *
 * IMPORTANT: This file runs in Temporal's sandboxed V8 isolate. It may only
 * import from `@temporalio/workflow` and TYPE-ONLY from activity modules.
 */

import { proxyActivities } from "@temporalio/workflow";
import type * as activities from "../activities";

const { linkMeetingActionItemsActivity } = proxyActivities<typeof activities>({
	// One embedding batch plus up to one LLM call per action item. The card's
	// NFR targets 30s for 50 items; this is generous headroom over that so a
	// slow provider does not turn into a retry storm.
	startToCloseTimeout: "300s",
	heartbeatTimeout: "2 minutes",
	retry: {
		initialInterval: "5s",
		backoffCoefficient: 2,
		maximumInterval: "1m",
		maximumAttempts: 3,
		nonRetryableErrorTypes: ["ValidationError", "TenantViolation"],
	},
});

export interface LinkMeetingActionItemsWorkflowInput {
	projectId: string;
	organizationId: string | null;
	userId: string;
	transcriptCuid: string;
	force?: boolean;
}

export interface LinkMeetingActionItemsWorkflowOutput {
	itemsConsidered: number;
	linksCreated: number;
	verifierFailures: number;
}

export async function linkMeetingActionItemsWorkflow(
	input: LinkMeetingActionItemsWorkflowInput,
): Promise<LinkMeetingActionItemsWorkflowOutput> {
	const result = await linkMeetingActionItemsActivity({
		projectId: input.projectId,
		organizationId: input.organizationId,
		userId: input.userId,
		transcriptCuid: input.transcriptCuid,
		force: input.force,
	});
	return {
		itemsConsidered: result.itemsConsidered,
		linksCreated: result.linksCreated,
		verifierFailures: result.verifierFailures,
	};
}
