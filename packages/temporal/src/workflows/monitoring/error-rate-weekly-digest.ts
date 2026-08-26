/**
 * errorRateWeeklyDigestWorkflow.
 *
 * Monday 09:00 UTC cron. Calls the weekly-digest helper via
 * `dispatchWeeklyDigestActivity`. The helper writes one Notification
 * per Fabric admin summarizing the prior week's SEV-3 incidents.
 *
 * Cron-via-Temporal-Schedule API. Body is intentionally thin — the
 * helper owns the aggregation logic.
 */
import { log, proxyActivities } from "@temporalio/workflow";
import type * as activities from "../../activities/monitoring";

const { dispatchWeeklyDigestActivity } = proxyActivities<typeof activities>({
	startToCloseTimeout: "2m",
	retry: { initialInterval: "5s", maximumAttempts: 3 },
});

export interface ErrorRateWeeklyDigestInput {
	/**
	 * Optional ISO timestamp for the week-end. When omitted the
	 * activity uses "now". Tests pass a fixed value.
	 */
	weekEndIso?: string;
}

export async function errorRateWeeklyDigestWorkflow(
	input: ErrorRateWeeklyDigestInput = {},
): Promise<void> {
	const result = await dispatchWeeklyDigestActivity({
		weekEndIso: input.weekEndIso,
	});

	log.info("errorRateWeeklyDigestWorkflow dispatched", {
		adminsNotified: result.adminsNotified,
		skipped: result.skipped,
		skipReason: result.skipReason,
	});
}
