/**
 * Recurring-error detection schedule bootstrap.
 *
 * Idempotently registers the twice-daily sweep that scans every project with
 * recurring-error detection switched on:
 *
 *   - recurring-error-scan — at 01:20 and 13:20 UTC
 *
 * Registered unconditionally: the per-project toggle is the gate, enforced by
 * the sweep's enumeration, so a project switched on is scanned on the next
 * tick with no redeploy and a deployment where nobody opted in runs an empty
 * sweep. `overlap: SKIP` plus project-scoped child workflow ids keep a slow
 * tick from stacking a second scan of the same project.
 *
 * Called from `packages/temporal/src/schedules.ts:registerSystemSchedules()`.
 */
import {
	ScheduleAlreadyRunning,
	type ScheduleClient,
} from "@temporalio/client";

// MUST match the worker registration in `packages/temporal/src/worker.ts`.
const TASK_QUEUE = "fabric-worker";

export const RECURRING_ERROR_SCAN_SCHEDULE = {
	id: "recurring-error-scan",
	workflowType: "recurringErrorSweepWorkflow",
	// Twice a day, off the hour and the quarter-hours the other sweeps use.
	cron: "20 1,13 * * *",
	note: "Twice daily, scans projects with recurring-error detection on and files a BUG proposal in the review inbox for each error group or cluster of open bug reports that recurs at least the project's threshold.",
} as const;

export async function ensureRecurringErrorSchedules(
	scheduleClient: ScheduleClient,
): Promise<void> {
	const config = RECURRING_ERROR_SCAN_SCHEDULE;
	try {
		await scheduleClient.create({
			scheduleId: config.id,
			spec: { cronExpressions: [config.cron] },
			action: {
				type: "startWorkflow",
				workflowType: config.workflowType,
				taskQueue: TASK_QUEUE,
				args: [{}],
			},
			policies: {
				overlap: "SKIP",
				// One tick, not a backlog: a worker down for a day resumes with
				// the current window instead of replaying missed scans.
				catchupWindow: "1 hour",
			},
			state: { paused: false, note: config.note },
		});
		console.log(
			`[Worker] Schedule "${config.id}" registered (twice daily)`,
		);
	} catch (error) {
		if (error instanceof ScheduleAlreadyRunning) {
			console.log(
				`[Worker] Schedule "${config.id}" already exists, skipping`,
			);
		} else {
			throw error;
		}
	}
}
