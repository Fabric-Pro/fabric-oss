/**
 * URL Source Schedules Reconciliation Workflow.
 *
 * Sweeps `url-source-schedule-*` Temporal Schedules and deletes orphans —
 * those whose underlying `ProjectContext` row no longer exists, has been
 * switched to ONCE/LIVE, or whose `urlScheduleId` no longer matches the
 * schedule ID we'd build from its `contextId`.
 *
 * Registered as a weekly Temporal Schedule in `registerSystemSchedules()`
 * (`packages/temporal/src/schedules.ts`). Runs every Sunday at 00:30 UTC
 * to stay out of the way of the per-context schedules that fire at 00:00.
 *
 * Determinism: all I/O lives in `reconcileUrlSourceSchedulesActivity`.
 * The workflow body just kicks the activity and surfaces the summary.
 */
import { proxyActivities } from "@temporalio/workflow";
import type * as activities from "../activities";

const { reconcileUrlSourceSchedulesActivity } = proxyActivities<
	typeof activities
>({
	startToCloseTimeout: "10 minutes",
	heartbeatTimeout: "30 seconds",
	retry: {
		initialInterval: "5s",
		maximumInterval: "60s",
		backoffCoefficient: 2,
		maximumAttempts: 3,
	},
});

export interface ReconcileUrlSourceSchedulesWorkflowInput {
	/** Dry-run prints the diff without deleting. Default false. */
	dryRun?: boolean;
}

export interface ReconcileUrlSourceSchedulesWorkflowOutput {
	scanned: number;
	orphansDeleted: number;
	dryRun: boolean;
}

export async function reconcileUrlSourceSchedulesWorkflow(
	input: ReconcileUrlSourceSchedulesWorkflowInput = {},
): Promise<ReconcileUrlSourceSchedulesWorkflowOutput> {
	const result = await reconcileUrlSourceSchedulesActivity({
		dryRun: input.dryRun ?? false,
	});
	return {
		scanned: result.scanned,
		orphansDeleted: result.orphansDeleted,
		dryRun: result.dryRun,
	};
}
