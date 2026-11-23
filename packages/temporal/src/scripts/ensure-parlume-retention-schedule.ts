/**
 * Parlume transcript retention schedule bootstrap.
 *
 * Idempotently registers the hourly sweep that deletes what Parlume meetings
 * said once they are 90 days old, and takes any Parlume transcript out of the
 * vector index:
 *
 *   - parlume-transcript-retention — every hour, at minute 35
 *
 * Registered unconditionally: a deployment with no Parlume sessions runs an
 * empty sweep. `overlap: SKIP` with an activity timeout shorter than the
 * interval keeps a slow run from stacking.
 *
 * Called from `packages/temporal/src/schedules.ts:registerSystemSchedules()`.
 */
import {
	ScheduleAlreadyRunning,
	type ScheduleClient,
} from "@temporalio/client";

// MUST match the worker registration in `packages/temporal/src/worker.ts`.
const TASK_QUEUE = "fabric-worker";

export const PARLUME_TRANSCRIPT_RETENTION_SCHEDULE = {
	id: "parlume-transcript-retention",
	workflowType: "parlumeTranscriptRetentionWorkflow",
	cron: "35 * * * *",
	note: "Every hour, deletes the transcript, webhook receipts and quoted words of each finished Parlume meeting older than 90 days, keeping the session and its notes, and removes Parlume transcripts from the vector index.",
} as const;

export async function ensureParlumeRetentionSchedule(
	scheduleClient: ScheduleClient,
): Promise<void> {
	const config = PARLUME_TRANSCRIPT_RETENTION_SCHEDULE;
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
				// The next run picks up whatever a missed one would have.
				catchupWindow: "1 hour",
			},
			state: { paused: false, note: config.note },
		});
		console.log(`[Worker] Schedule "${config.id}" registered (hourly)`);
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
