/**
 * dispatchProjectServiceAlertDigest activity.
 *
 * Thin wrapper over the `@repo/database` helper. Called from the
 * projectServiceAlertDigestWorkflow Monday cron (Notification Center
 * Preferences AC-9). Best-effort: the helper returns a summary even when it
 * wrote no rows (no alerts this week), which the activity surfaces so the
 * workflow log shows what happened.
 */
import { dispatchProjectServiceAlertDigest } from "@repo/database/prisma/queries/project-service-alert-digest";

export interface DispatchProjectServiceAlertDigestInput {
	/**
	 * Optional ISO timestamp for the week-end (exclusive upper bound). When
	 * omitted the activity uses "now". Tests pass a fixed value to pin the
	 * windowing.
	 */
	weekEndIso?: string;
}

export interface DispatchProjectServiceAlertDigestOutput {
	projectsNotified: number;
	adminsNotified: number;
	skipped: boolean;
	skipReason?: string;
}

export async function dispatchProjectServiceAlertDigestActivity(
	input: DispatchProjectServiceAlertDigestInput = {},
): Promise<DispatchProjectServiceAlertDigestOutput> {
	const weekEnd = input.weekEndIso ? new Date(input.weekEndIso) : new Date();
	const result = await dispatchProjectServiceAlertDigest(weekEnd);
	return {
		projectsNotified: result.projectsNotified,
		adminsNotified: result.adminsNotified,
		skipped: result.skipped,
		skipReason: result.skipReason,
	};
}
