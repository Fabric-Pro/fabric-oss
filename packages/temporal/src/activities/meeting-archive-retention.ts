/**
 * Purges expired meeting-recovery archives (Fizzy #2355).
 *
 * A side-effect holder for its otherwise-deterministic workflow: the clock read
 * and the Prisma call live here so the workflow replays cleanly. Mirrors
 * `background-job-retention.ts`.
 *
 * The window itself is NOT configurable here. It is stamped onto each row as
 * `scheduledPurgeAt` when the meeting is deleted, so a row's fate is fixed at
 * deletion time and cannot be shortened retroactively by changing a setting —
 * which is the property that makes "recoverable until <date>" honest.
 */

import { purgeExpiredMeetingArchives } from "@repo/database";
import { logger } from "@repo/logs";

export type PurgeExpiredMeetingArchivesOutput = {
	deleted: number;
	batches: number;
};

export async function purgeExpiredMeetingArchivesActivity(): Promise<PurgeExpiredMeetingArchivesOutput> {
	const { deleted, batches } = await purgeExpiredMeetingArchives({});

	logger.info("[MeetingArchiveRetention] Purge complete", {
		deleted,
		batches,
	});

	return { deleted, batches };
}
