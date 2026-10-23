import {
	listProjectsDueForRecurringErrorScan,
	type ProjectDueForRecurringErrorScan,
} from "@repo/database";

/**
 * Activity: which projects the scheduled recurring-error sweep visits this
 * tick. A thin wrapper so the enumeration is I/O in an activity rather than in
 * the replay-safe workflow body. No feature flag: the per-project toggle is
 * the gate, and the query only returns projects that switched it on.
 */
export async function listProjectsDueForRecurringErrorScanActivity(input?: {
	limit?: number;
}): Promise<ProjectDueForRecurringErrorScan[]> {
	return listProjectsDueForRecurringErrorScan({ limit: input?.limit });
}
