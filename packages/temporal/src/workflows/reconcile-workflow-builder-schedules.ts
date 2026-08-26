/**
 * Workflow-builder schedule reconciliation.
 *
 * Sweeps `workflow-builder-*` Temporal Schedules and deletes the orphans:
 * those whose workflow no longer exists, is no longer published, or whose
 * trigger is no longer a Schedule.
 *
 * Schedule sync is best-effort by design — `syncWorkflowSchedule` never throws,
 * so a publish is not blocked by Temporal being briefly unreachable. This is
 * what closes the gap that leaves behind.
 *
 * Registered as a weekly Schedule in `registerSystemSchedules()`. Determinism:
 * all I/O lives in the activity; the workflow body just kicks it and surfaces
 * the summary.
 */

import { proxyActivities } from "@temporalio/workflow";
import type * as activities from "../activities";

const { reconcileWorkflowSchedulesActivity } = proxyActivities<
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

export interface ReconcileWorkflowSchedulesWorkflowInput {
	/** Report the diff without deleting. Default false. */
	dryRun?: boolean;
}

export interface ReconcileWorkflowSchedulesWorkflowOutput {
	scanned: number;
	orphansDeleted: number;
	dryRun: boolean;
	reasons: Record<string, number>;
}

export async function reconcileWorkflowBuilderSchedulesWorkflow(
	input: ReconcileWorkflowSchedulesWorkflowInput = {},
): Promise<ReconcileWorkflowSchedulesWorkflowOutput> {
	return await reconcileWorkflowSchedulesActivity({
		dryRun: input.dryRun ?? false,
	});
}
