/**
 * AI-usage schedules bootstrap.
 *
 * Idempotently registers the AI-cost reconciliation cron via the Temporal
 * Schedule API:
 *
 *   - ai-usage-gateway-cost-reconciliation — every 5 minutes
 *
 * The workflow (`reconcileAiGatewayCostWorkflow`) also self-loops via
 * sleep + continueAsNew, so overlap=SKIP means this Schedule only re-spawns it
 * if the self-loop ever dies — never a duplicate sweep. Re-running on worker
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

const RECONCILE_SCHEDULE = {
	id: "ai-usage-gateway-cost-reconciliation",
	workflowType: "reconcileAiGatewayCostWorkflow",
	cron: "*/5 * * * *",
	note: "Flips recent Vercel-gateway AI usage rows from estimate to the provider's actual billed cost.",
} as const;

export async function ensureAiUsageSchedules(
	scheduleClient: ScheduleClient,
): Promise<void> {
	const config = RECONCILE_SCHEDULE;
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
				catchupWindow: "10 minutes",
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
