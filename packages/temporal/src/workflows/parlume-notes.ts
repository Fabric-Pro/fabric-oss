import { proxyActivities } from "@temporalio/workflow";
import type * as activities from "../activities";
import { PROJECT_OPERATIONS_ACTIVITY_TASK_QUEUE } from "../task-queues";

const { writeParlumeNotes } = proxyActivities<typeof activities>({
	taskQueue: PROJECT_OPERATIONS_ACTIVITY_TASK_QUEUE,
	startToCloseTimeout: "3 minutes",
	retry: { maximumAttempts: 2 },
});

export async function parlumeNotesWorkflow(input: {
	sessionId: string;
}): Promise<void> {
	await writeParlumeNotes(input);
}
