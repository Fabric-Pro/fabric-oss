import { proxyActivities } from "@temporalio/workflow";
import type * as activities from "../activities";
import { PROJECT_OPERATIONS_ACTIVITY_TASK_QUEUE } from "../task-queues";
import { withChatGptPlanWait } from "./lib/chatgpt-plan-wait";

const { writeParlumeNotes } = proxyActivities<typeof activities>({
	taskQueue: PROJECT_OPERATIONS_ACTIVITY_TASK_QUEUE,
	startToCloseTimeout: "3 minutes",
	retry: {
		maximumAttempts: 2,
		// Retrying cannot refill a spent ChatGPT plan; `withChatGptPlanWait`
		// waits for a reset instead (Fizzy #2770). Retry options are not part
		// of the command sequence, so no `patched()` guard.
		nonRetryableErrorTypes: ["SubscriptionPlanExhaustedError"],
	},
});

export async function parlumeNotesWorkflow(input: {
	sessionId: string;
	/** Absent on runs started before the shared-plan wait (Fizzy #2770). */
	organizationId?: string | null;
	userId?: string | null;
}): Promise<void> {
	// The notes may run on a shared ChatGPT plan: when every plan is spent the
	// run waits for a reset and writes them once more, and only that second
	// attempt records the notes as failed. The helper's own `patched()` keeps
	// older histories unchanged.
	let attempt = 0;
	await withChatGptPlanWait(
		() =>
			writeParlumeNotes({
				sessionId: input.sessionId,
				finalAttempt: attempt++ > 0,
			}),
		{ organizationId: input.organizationId, userId: input.userId },
	);
}
