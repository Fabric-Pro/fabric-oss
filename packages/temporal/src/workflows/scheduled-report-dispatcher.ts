import { log, proxyActivities } from "@temporalio/workflow";
import type {
	dispatchScheduledReportActivity as DispatchFn,
	findDueReportInstancesActivity as FindDueFn,
	reconcileScheduledReportInstancesActivity as ReconcileFn,
} from "../activities/scheduled-report";

const { reconcileScheduledReportInstancesActivity } = proxyActivities<{
	reconcileScheduledReportInstancesActivity: typeof ReconcileFn;
}>({
	startToCloseTimeout: "5 minutes",
	heartbeatTimeout: "1 minute",
	retry: { maximumAttempts: 3, initialInterval: "2s" },
});

const { findDueReportInstancesActivity } = proxyActivities<{
	findDueReportInstancesActivity: typeof FindDueFn;
}>({
	startToCloseTimeout: "1 minute",
	heartbeatTimeout: "30 seconds",
	retry: { maximumAttempts: 3, initialInterval: "2s" },
});

const { dispatchScheduledReportActivity } = proxyActivities<{
	dispatchScheduledReportActivity: typeof DispatchFn;
}>({
	startToCloseTimeout: "2 minutes",
	heartbeatTimeout: "30 seconds",
	retry: { maximumAttempts: 3, initialInterval: "2s" },
});

/**
 * Fires due scheduled report instances. Triggered by the
 * `scheduled-report-generation` Temporal Schedule every 15 minutes.
 *
 * Pure orchestration — NO time logic here (all "now" lives in the activities):
 *   1. reconcile/backfill (inherit owner-owned template schedules + compute missing nextRunAt)
 *   2. find due instances
 *   3. dispatch each (per-row try/catch so one failure never blocks the rest of the sweep)
 */
export async function scheduledReportDispatcherWorkflow(): Promise<{
	reconciled: number;
	dispatched: number;
}> {
	const { inherited, computed } =
		await reconcileScheduledReportInstancesActivity({
			batchSize: 100,
		});
	const reconciled = inherited + computed;

	const { due } = await findDueReportInstancesActivity();
	let dispatched = 0;
	for (const row of due) {
		try {
			await dispatchScheduledReportActivity(row);
			dispatched += 1;
		} catch (error) {
			// One instance's failure must not block the rest of the sweep.
			log.error("[ScheduledReport] dispatch failed for instance", {
				instanceId: row.id,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
	return { reconciled, dispatched };
}
