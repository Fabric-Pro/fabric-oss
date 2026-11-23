/**
 * Parlume stranded-session sweep schedule bootstrap.
 *
 * Idempotently registers the sweep that finalizes, in every project, the
 * Parlume sessions the bridge can no longer finish (a lost alarm leaves one
 * LEAVING with its bot long gone):
 *
 *   - parlume-session-sweep — every ten minutes
 *
 * Registered unconditionally: a deployment with no stranded session runs an
 * empty sweep. `overlap: SKIP` with an activity timeout shorter than the
 * interval keeps a slow run from stacking. The Parlume page's list procedure
 * still sweeps its own project when it is opened.
 *
 * Called from `packages/temporal/src/schedules.ts:registerSystemSchedules()`.
 */
import {
	ScheduleAlreadyRunning,
	type ScheduleClient,
} from "@temporalio/client";

// MUST match the worker registration in `packages/temporal/src/worker.ts`.
const TASK_QUEUE = "fabric-worker";

export const PARLUME_SESSION_SWEEP_SCHEDULE = {
	id: "parlume-session-sweep",
	workflowType: "parlumeSessionSweepWorkflow",
	cron: "*/10 * * * *",
	note: "Every ten minutes, finalizes the Parlume sessions of every project whose bot the provider reported gone but whose stream close never arrived, at their hard stop or fifteen minutes after that report.",
} as const;

export async function ensureParlumeSweepSchedule(
	scheduleClient: ScheduleClient,
): Promise<void> {
	const config = PARLUME_SESSION_SWEEP_SCHEDULE;
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
				// The next tick sweeps whatever a missed one would have.
				catchupWindow: "10 minutes",
			},
			state: { paused: false, note: config.note },
		});
		console.log(
			`[Worker] Schedule "${config.id}" registered (every 10 minutes)`,
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
