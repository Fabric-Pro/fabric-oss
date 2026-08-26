import {
	getScheduledInstances,
	parseStoredReportSchedule,
	type ReportScheduleConfig,
} from "@repo/database";
import { heartbeat } from "@temporalio/activity";

/** A scheduled report instance that is due to run, as a serializable activity payload. */
export interface DueReportInstance {
	id: string;
	schedule: ReportScheduleConfig;
	/** The observed due time (ISO) — the compare-and-swap key for advancing nextRunAt. */
	nextRunAt: string;
	userId: string;
	organizationId: string | null;
}

/**
 * Find active report instances whose `nextRunAt` is at/before now. Rows whose stored
 * schedule isn't a valid normalized config (or have no nextRunAt) are skipped here —
 * the reconcile pass normalizes/repairs them before they become due.
 */
export async function findDueReportInstancesActivity(): Promise<{
	due: DueReportInstance[];
}> {
	heartbeat("findDueReportInstances");
	const rows = await getScheduledInstances(new Date());
	const due: DueReportInstance[] = [];
	for (const r of rows) {
		const schedule = parseStoredReportSchedule(r.schedule);
		if (!schedule || !r.nextRunAt) {
			continue;
		}
		due.push({
			id: r.id,
			schedule,
			nextRunAt: r.nextRunAt.toISOString(),
			userId: r.userId,
			organizationId: r.organizationId ?? null,
		});
	}
	return { due };
}
