import { proxyActivities } from "@temporalio/workflow";
import type * as activities from "../activities";

const { writeParlumeNotes } = proxyActivities<typeof activities>({
	startToCloseTimeout: "3 minutes",
	retry: { maximumAttempts: 2 },
});

export async function parlumeNotesWorkflow(input: {
	sessionId: string;
}): Promise<void> {
	await writeParlumeNotes(input);
}
