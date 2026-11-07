import {
	ActivityCancellationType,
	proxyActivities,
} from "@temporalio/workflow";
import type {
	HarnessTriageActivities,
	HarnessTriageWorkflowInput,
} from "../lib/harness-triage-contracts";

const work = proxyActivities<HarnessTriageActivities>({
	startToCloseTimeout: "3 minutes",
	scheduleToCloseTimeout: "10 minutes",
	heartbeatTimeout: "15 seconds",
	cancellationType: ActivityCancellationType.WAIT_CANCELLATION_COMPLETED,
	retry: { maximumAttempts: 3, initialInterval: "2 seconds" },
});
const retention = proxyActivities<HarnessTriageActivities>({
	startToCloseTimeout: "5 minutes",
	retry: { maximumAttempts: 5, initialInterval: "10 seconds" },
});
/** Native Temporal retry/cancellation; no private bodies or credentials in history. */
export async function harnessSignalTriageWorkflow(
	input: HarnessTriageWorkflowInput,
) {
	return work.executeHarnessTriage(input);
}
export async function harnessTriageRetentionWorkflow() {
	return retention.purgeExpiredHarnessTriageContent();
}
