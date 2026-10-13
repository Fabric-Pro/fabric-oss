import { proxyActivities } from "@temporalio/workflow";
import type {
	DueDocument,
	RefreshOutcome,
	runDocumentRefreshActivity as RunFn,
} from "../activities/document-refresh";
import { withChatGptPlanWait } from "./lib/chatgpt-plan-wait";

// The dispatcher bounds each refresh at one hour; a longer wait would only
// time the run out. The hourly sweep is the outer retry loop.
const DOCUMENT_REFRESH_MAX_PLAN_WAIT_MS = 30 * 60_000;

/**
 * One document's refresh, as its own workflow so a slow model call cannot delay
 * the rest of the sweep and so each refresh gets its own retry policy and
 * history.
 *
 * The workflow id is deterministic (document + cadence period), so a duplicate
 * dispatch is rejected by Temporal rather than deduped by a table.
 */

const { runDocumentRefreshActivity } = proxyActivities<{
	runDocumentRefreshActivity: typeof RunFn;
}>({
	// A model call over a whole document plus its project context. Generous, and
	// bounded by the workflow's own one-hour execution timeout.
	startToCloseTimeout: "20 minutes",
	heartbeatTimeout: "2 minutes",
	// The activity records its own FAILED outcome and rethrows, so retries here
	// are for transient faults (provider blips, DB hiccups) — not for a document
	// that is genuinely un-refreshable. The hourly sweep, gated by the attempt
	// backoff, is the outer retry loop.
	retry: {
		maximumAttempts: 2,
		initialInterval: "30s",
		// Retrying cannot refill a spent ChatGPT plan; the workflow waits for a
		// reset instead (Fizzy #2770). Retry options are not part of the
		// command sequence, so no `patched()` guard.
		nonRetryableErrorTypes: ["SubscriptionPlanExhaustedError"],
	},
});

export async function documentRefreshWorkflow(
	due: DueDocument,
): Promise<RefreshOutcome> {
	// The refresh may run on a shared ChatGPT plan: when every plan is spent it
	// waits for a reset and runs once more, within the workflow's one-hour
	// execution timeout. The helper's own `patched()` keeps older histories
	// unchanged.
	return await withChatGptPlanWait(() => runDocumentRefreshActivity(due), {
		organizationId: due.organizationId,
		userId: due.triggeredByUserId,
		maxWaitMs: DOCUMENT_REFRESH_MAX_PLAN_WAIT_MS,
	});
}
