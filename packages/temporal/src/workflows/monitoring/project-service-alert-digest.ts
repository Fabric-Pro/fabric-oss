/**
 * projectServiceAlertDigestWorkflow.
 *
 * Monday 09:00 UTC cron (Notification Center Preferences AC-9). Calls the
 * project service-alert digest helper via
 * `dispatchProjectServiceAlertDigestActivity`, which writes one Notification
 * per project admin (OWNER / PROJECT_ADMIN) summarizing the prior week's
 * PM-sync failures and conflicts for each project that had any.
 *
 * Cron-via-Temporal-Schedule API. Body is intentionally thin — the helper owns
 * the aggregation logic — so replay-validation stays stable.
 */
import { log, proxyActivities } from "@temporalio/workflow";
import type * as activities from "../../activities/monitoring";

const { dispatchProjectServiceAlertDigestActivity } = proxyActivities<
	typeof activities
>({
	startToCloseTimeout: "2m",
	retry: { initialInterval: "5s", maximumAttempts: 3 },
});

export interface ProjectServiceAlertDigestInput {
	/**
	 * Optional ISO timestamp for the week-end. When omitted the activity uses
	 * "now". Tests pass a fixed value.
	 */
	weekEndIso?: string;
}

export async function projectServiceAlertDigestWorkflow(
	input: ProjectServiceAlertDigestInput = {},
): Promise<void> {
	const result = await dispatchProjectServiceAlertDigestActivity({
		weekEndIso: input.weekEndIso,
	});

	log.info("projectServiceAlertDigestWorkflow dispatched", {
		projectsNotified: result.projectsNotified,
		adminsNotified: result.adminsNotified,
		skipped: result.skipped,
		skipReason: result.skipReason,
	});
}
