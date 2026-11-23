import { proxyActivities } from "@temporalio/workflow";
import type * as activities from "../activities";

const { purgeExpiredParlumeTranscripts } = proxyActivities<typeof activities>({
	// Shorter than the hourly schedule, which skips a tick that overlaps.
	startToCloseTimeout: "10 minutes",
	retry: { maximumAttempts: 3 },
});

/** Every hour: delete what Parlume meetings said once they are 90 days old. */
export async function parlumeTranscriptRetentionWorkflow(): Promise<
	Awaited<ReturnType<typeof purgeExpiredParlumeTranscripts>>
> {
	return purgeExpiredParlumeTranscripts();
}
