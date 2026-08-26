/**
 * pruneOldIncidentsWorkflow.
 *
 * Nightly cron via Temporal Schedule. The workflow calls
 * `pruneIncidents` (deletes rows older than 365 days), sleeps 24h, and
 * `continueAsNew`. The sleep + CAN exists as defense-in-depth for the
 * unlikely case where the Schedule fails to spawn a fresh run.
 */
import {
	continueAsNew,
	log,
	proxyActivities,
	sleep,
} from "@temporalio/workflow";
import type * as activities from "../../activities/monitoring";

const { pruneIncidents } = proxyActivities<typeof activities>({
	startToCloseTimeout: "10m", // Bulk delete on a large table.
	retry: { initialInterval: "30s", maximumAttempts: 3 },
});

export interface PruneOldIncidentsInput {
	/** Retention threshold in days. Defaults to 365 per L13. */
	olderThanDays?: number;
}

export async function pruneOldIncidentsWorkflow(
	input: PruneOldIncidentsInput = {},
): Promise<void> {
	const olderThanDays = input.olderThanDays ?? 365;

	try {
		const result = await pruneIncidents({ olderThanDays });
		log.info("pruneOldIncidentsWorkflow completed one pass", {
			errorRateDeleted: result.errorRateDeleted,
			integrationDeleted: result.integrationDeleted,
			cutoff: result.cutoff,
		});
	} catch (err) {
		log.warn("pruneOldIncidentsWorkflow pass failed", {
			error: err instanceof Error ? err.message : String(err),
		});
	}

	await sleep("24h");
	await continueAsNew<typeof pruneOldIncidentsWorkflow>({ olderThanDays });
}
