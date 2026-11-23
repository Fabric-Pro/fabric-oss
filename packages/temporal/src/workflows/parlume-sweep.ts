import { proxyActivities } from "@temporalio/workflow";
import type * as activities from "../activities";

const { requestParlumeSessionSweep } = proxyActivities<typeof activities>({
	// Shorter than the ten-minute schedule, which skips a tick that overlaps.
	startToCloseTimeout: "3 minutes",
	// The next tick is the retry.
	retry: { maximumAttempts: 1 },
});

/**
 * Every ten minutes: finalize the Parlume sessions of every project that
 * the bridge can no longer finish, such as one left LEAVING by a lost alarm.
 */
export async function parlumeSessionSweepWorkflow(): Promise<
	Awaited<ReturnType<typeof requestParlumeSessionSweep>>
> {
	return requestParlumeSessionSweep();
}
