import { proxyActivities } from "@temporalio/workflow";
import type {
	DueDocument,
	RefreshOutcome,
	runDocumentRefreshActivity as RunFn,
} from "../activities/document-refresh";

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
	retry: { maximumAttempts: 2, initialInterval: "30s" },
});

export async function documentRefreshWorkflow(
	due: DueDocument,
): Promise<RefreshOutcome> {
	return await runDocumentRefreshActivity(due);
}
