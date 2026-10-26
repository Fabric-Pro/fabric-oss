/**
 * Parlume auto-join schedule bootstrap.
 *
 * Idempotently registers the five-minute planner that finds the occurrences
 * of linked meeting series with Parlume auto-join on and schedules a join for
 * each:
 *
 *   - parlume-auto-join-planner — every five minutes
 *
 * Registered unconditionally: the per-series switch and the organization's
 * flags are the gate, enforced by the planner's enumeration, so a deployment
 * where nobody turned auto-join on runs an empty plan. `overlap: SKIP` with an
 * activity timeout shorter than the interval keeps a slow run from stacking.
 *
 * Called from `packages/temporal/src/schedules.ts:registerSystemSchedules()`.
 */
import {
	ScheduleAlreadyRunning,
	type ScheduleClient,
} from "@temporalio/client";

// MUST match the worker registration in `packages/temporal/src/worker.ts`.
const TASK_QUEUE = "fabric-worker";

export const PARLUME_AUTO_JOIN_PLANNER_SCHEDULE = {
	id: "parlume-auto-join-planner",
	workflowType: "parlumeAutoJoinPlannerWorkflow",
	cron: "*/5 * * * *",
	note: "Every five minutes, reads the Teams calendar of each person who turned on Parlume auto-join for a linked meeting series and schedules Parlume to join each occurrence starting in the next 15 minutes.",
} as const;

export async function ensureParlumeAutoJoinSchedule(
	scheduleClient: ScheduleClient,
): Promise<void> {
	const config = PARLUME_AUTO_JOIN_PLANNER_SCHEDULE;
	try {
		await scheduleClient.create({
			scheduleId: config.id,
			spec: { cronExpressions: [config.cron] },
			action: {
				type: "startWorkflow",
				workflowType: config.workflowType,
				taskQueue: TASK_QUEUE,
				args: [],
			},
			policies: {
				overlap: "SKIP",
				// A missed tick is not worth replaying: the next one plans the
				// same window, and anything older is past its join time.
				catchupWindow: "5 minutes",
			},
			state: { paused: false, note: config.note },
		});
		console.log(
			`[Worker] Schedule "${config.id}" registered (every 5 minutes)`,
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
