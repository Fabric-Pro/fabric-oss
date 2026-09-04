/**
 * Daily purge of expired meeting-recovery archives (Fizzy #2355).
 *
 * Deliberately empty of side effects — no env read, no `Date.now()`, no Prisma —
 * so replay stays deterministic. Everything that touches the world lives in the
 * activity.
 */

import { proxyActivities } from "@temporalio/workflow";
import type * as activities from "../activities";

const { purgeExpiredMeetingArchivesActivity } = proxyActivities<
	typeof activities
>({
	startToCloseTimeout: "10 minutes",
	retry: {
		// Idempotent in effect: a retry after partial progress purges whatever
		// still falls past its own scheduledPurgeAt.
		initialInterval: "30 seconds",
		maximumInterval: "5 minutes",
		backoffCoefficient: 2,
		maximumAttempts: 3,
	},
});

export async function meetingArchiveRetentionWorkflow(): Promise<{
	deleted: number;
	batches: number;
}> {
	return await purgeExpiredMeetingArchivesActivity();
}
