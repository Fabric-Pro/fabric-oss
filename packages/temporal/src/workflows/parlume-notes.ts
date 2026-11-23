import { patched, proxyActivities } from "@temporalio/workflow";
import type * as activities from "../activities";
import { PARLUME_NOTES_MAX_ATTEMPTS } from "../lib/parlume-notes-retry";
import { PROJECT_OPERATIONS_ACTIVITY_TASK_QUEUE } from "../task-queues";
import { withChatGptPlanWait } from "./lib/chatgpt-plan-wait";

const { writeParlumeNotes } = proxyActivities<typeof activities>({
	taskQueue: PROJECT_OPERATIONS_ACTIVITY_TASK_QUEUE,
	// A long meeting is written in checkpoint parts and a merge, several
	// model calls in one attempt.
	startToCloseTimeout: "15 minutes",
	retry: {
		// A failed model call is retried, and only the last attempt records
		// the notes as failed: the activity is told the same number.
		maximumAttempts: PARLUME_NOTES_MAX_ATTEMPTS,
		// Retrying cannot refill a spent ChatGPT plan; `withChatGptPlanWait`
		// waits for a reset instead. Retry options, timeouts and activity
		// arguments are not part of the command sequence, so no `patched()`
		// guard.
		nonRetryableErrorTypes: ["SubscriptionPlanExhaustedError"],
	},
});

// The notice is told once: a send that fails is dropped, not retried.
const { notifyParlumeNotesReady } = proxyActivities<typeof activities>({
	taskQueue: PROJECT_OPERATIONS_ACTIVITY_TASK_QUEUE,
	startToCloseTimeout: "1 minute",
	retry: { maximumAttempts: 1 },
});

const PARLUME_NOTES_READY_NOTICE_PATCH = "parlume-notes-ready-notice";

export async function parlumeNotesWorkflow(input: {
	sessionId: string;
	/** Absent on runs started before the shared-plan wait. */
	organizationId?: string | null;
	userId?: string | null;
	/** Started by "Regenerate notes", under its own workflow id. */
	regenerate?: boolean;
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
				regenerate: input.regenerate === true,
				maxAttempts: PARLUME_NOTES_MAX_ATTEMPTS,
			}),
		{ organizationId: input.organizationId, userId: input.userId },
	);
	// The invitees are told the notes are ready. The activity sends only for
	// notes recorded as COMPLETED, and once per session: a regenerated run
	// finds the notice claimed and sends nothing. A notice that fails leaves
	// the notes written, so it never fails the run. A command added after
	// the notes, so histories recorded before it replay unchanged.
	if (patched(PARLUME_NOTES_READY_NOTICE_PATCH)) {
		try {
			await notifyParlumeNotesReady({ sessionId: input.sessionId });
		} catch {
			// Temporal records the failed activity; the notes stay written.
		}
	}
}
