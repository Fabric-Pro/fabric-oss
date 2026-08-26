/**
 * Context-summarization schedule bootstrap.
 *
 * Idempotently registers the auto-scan cron via the Temporal Schedule API:
 *
 *   - context-summarization-auto-scan — daily at 02:30 UTC
 *
 * The scan workflow's handler no-ops when the feature flag
 * (`FABRIC_FEATURE_CONTEXT_SUMMARIZATION`) is off, so the schedule is ALWAYS
 * registered — flag gating lives in the handler, not in registration, so
 * flipping the flag on takes effect on the next tick with no redeploy. The
 * 02:30 UTC slot sits clear of the 03:00 retention cluster. Re-running on worker
 * boot is a no-op for an existing schedule.
 *
 * Called from `packages/temporal/src/schedules.ts:registerSystemSchedules()`.
 */
import {
	ScheduleAlreadyRunning,
	type ScheduleClient,
} from "@temporalio/client";

// MUST match the worker registration in `packages/temporal/src/worker.ts`.
const TASK_QUEUE = "fabric-worker";

const SCAN_SCHEDULE = {
	id: "context-summarization-auto-scan",
	workflowType: "contextSummarizationScanWorkflow",
	cron: "30 2 * * *", // daily 02:30 UTC
	note: "Daily sweep: dispatches context-summarization runs for projects whose raw-context volume crosses the token threshold or whose summary has gone stale. No-op when FABRIC_FEATURE_CONTEXT_SUMMARIZATION is off.",
} as const;

export async function ensureContextSummarizationSchedules(
	scheduleClient: ScheduleClient,
): Promise<void> {
	const config = SCAN_SCHEDULE;
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
				catchupWindow: "1 hour",
			},
			state: { paused: false, note: config.note },
		});
		console.log(
			`[Worker] Schedule "${config.id}" registered (daily at 02:30 UTC)`,
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
