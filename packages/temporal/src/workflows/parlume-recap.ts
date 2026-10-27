import { proxyActivities } from "@temporalio/workflow";
import type * as activities from "../activities";

const { postParlumeSeriesRecap } = proxyActivities<typeof activities>({
	startToCloseTimeout: "2 minutes",
	// A recap is only useful at the start of the meeting, and a retry could
	// post it twice.
	retry: { maximumAttempts: 1 },
});

/**
 * Fire-and-forget: started once when the meeting bot is admitted to a meeting
 * of a linked series, under a workflow id derived from the session, so a
 * repeated start finds this run instead of posting a second recap. Nothing
 * waits on it and a failure changes nothing.
 */
export async function parlumeRecapWorkflow(input: {
	sessionId: string;
}): Promise<void> {
	try {
		await postParlumeSeriesRecap(input);
	} catch {
		// A recap that fails is simply not posted.
	}
}
