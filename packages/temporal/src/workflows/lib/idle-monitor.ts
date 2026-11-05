/**
 * What a polling monitor does after a tick that found nothing linked.
 *
 * The monitors' `continueAsNew` check sits at the end of a tick that had work,
 * and an empty tick returns to the loop before reaching it. A monitor with
 * nothing linked therefore kept every tick in one history, towards Temporal's
 * limit of 51,200 events, and replaying that history after a worker restart
 * outlasted the 10 second workflow task timeout. Deleting a project leaves its
 * monitor in exactly this state, polling forever.
 *
 * The patch keeps histories recorded before this shipped replaying as they ran:
 * their empty ticks scheduled nothing here.
 */

import {
	isCancellation,
	log,
	patched,
	proxyActivities,
	workflowInfo,
} from "@temporalio/workflow";
import type { monitoredProjectExistsActivity as MonitoredProjectExistsFn } from "../../activities/monitored-project";
import { PROJECT_OPERATIONS_ACTIVITY_TASK_QUEUE } from "../../task-queues";

const activities = proxyActivities<{
	monitoredProjectExistsActivity: typeof MonitoredProjectExistsFn;
}>({
	taskQueue: PROJECT_OPERATIONS_ACTIVITY_TASK_QUEUE,
	startToCloseTimeout: "30 seconds",
	retry: {
		initialInterval: "2s",
		backoffCoefficient: 2,
		maximumInterval: "30s",
		maximumAttempts: 3,
	},
});

export type IdleMonitorAction = "end" | "continue-as-new" | "keep-polling";

/**
 * Only a project confirmed gone ends the monitor. A failed check keeps it
 * running, because ending a live project's monitor is the worse mistake and the
 * next empty tick asks again.
 */
export async function resolveIdleMonitorAction(
	projectId: string,
): Promise<IdleMonitorAction> {
	if (!patched("idle-monitor-lifecycle-2026-11")) {
		return "keep-polling";
	}

	try {
		if (!(await activities.monitoredProjectExistsActivity({ projectId }))) {
			log.info("Ending monitor: its project no longer exists", {
				projectId,
			});
			return "end";
		}
	} catch (error) {
		if (isCancellation(error)) {
			throw error;
		}
		log.warn("Could not check the monitor's project; polling on", {
			projectId,
			error: error instanceof Error ? error.message : String(error),
		});
	}

	return workflowInfo().continueAsNewSuggested
		? "continue-as-new"
		: "keep-polling";
}
