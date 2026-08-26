/**
 * Auto-trigger scan for context summarization. Fired by the
 * `context-summarization-auto-scan` daily Temporal Schedule.
 *
 * Pure orchestration — all the work (feature-flag check, candidate scan,
 * per-project qualification, and dispatch) lives in the single activity so it
 * can touch the DB and the Temporal client. Mirrors the
 * `scheduledReportDispatcherWorkflow` shape.
 */

import { proxyActivities } from "@temporalio/workflow";
import type { scanAndDispatchContextSummariesActivity as ScanFn } from "../activities/context-summarization/scan-and-dispatch";

const { scanAndDispatchContextSummariesActivity } = proxyActivities<{
	scanAndDispatchContextSummariesActivity: typeof ScanFn;
}>({
	startToCloseTimeout: "10 minutes",
	heartbeatTimeout: "1 minute",
	retry: { initialInterval: "5s", backoffCoefficient: 2, maximumAttempts: 3 },
});

export async function contextSummarizationScanWorkflow(): Promise<{
	scanned: number;
	dispatched: number;
}> {
	return scanAndDispatchContextSummariesActivity();
}
