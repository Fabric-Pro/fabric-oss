import { proxyActivities } from "@temporalio/workflow";
import type * as activities from "../activities";

const { warmParlumeSession } = proxyActivities<typeof activities>({
	startToCloseTimeout: "30 seconds",
	retry: { maximumAttempts: 1 },
});

/**
 * Fire-and-forget: started when the meeting bot is admitted, so the worker has
 * done the first steps of a spoken turn before the first question. Nothing
 * waits on it and a failure changes nothing.
 */
export async function parlumeWarmupWorkflow(input: {
	sessionId: string;
	actingGrant?: string;
}): Promise<void> {
	try {
		await warmParlumeSession(input);
	} catch {
		// A warm-up that fails is simply not warm.
	}
}
