import { proxyActivities } from "@temporalio/workflow";
import type * as activities from "../activities";

const { recoverContextQualityEvaluations } = proxyActivities<typeof activities>(
	{ startToCloseTimeout: "10 minutes", retry: { maximumAttempts: 3 } },
);
export async function contextQualityRecoveryWorkflow() {
	return recoverContextQualityEvaluations();
}
