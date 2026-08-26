/**
 * dispatchWeeklyIncidentDigest activity.
 *
 * Thin wrapper over the helper. Called from the
 * errorRateWeeklyDigestWorkflow Monday cron.
 *
 * The helper itself is best-effort: it returns a summary even when it
 * couldn't write any rows (e.g., no admins configured, no incidents
 * this week). The activity surfaces that summary so the workflow log
 * shows what happened.
 */
import { dispatchWeeklyIncidentDigest } from "@repo/database/prisma/queries/incident-weekly-digest";

export interface DispatchWeeklyDigestInput {
	/**
	 * Optional ISO timestamp for the week-end (exclusive upper bound).
	 * When omitted the activity uses "now". Tests pass a fixed value to
	 * pin the windowing.
	 */
	weekEndIso?: string;
}

export interface DispatchWeeklyDigestOutput {
	adminsNotified: number;
	skipped: boolean;
	skipReason?: string;
}

export async function dispatchWeeklyDigestActivity(
	input: DispatchWeeklyDigestInput = {},
): Promise<DispatchWeeklyDigestOutput> {
	const weekEnd = input.weekEndIso ? new Date(input.weekEndIso) : new Date();
	const result = await dispatchWeeklyIncidentDigest(weekEnd);
	return {
		adminsNotified: result.adminsNotified,
		skipped: result.skipped,
		skipReason: result.skipReason,
	};
}
