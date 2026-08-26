/**
 * Attachment Retention-Purge Workflow (#1702 Part 5).
 *
 * Scheduled daily (unconditional; schedules.ts). Delegates entirely to
 * purgeExpiredAttachmentsActivity. Body is
 * deterministic — no Date.now(), no env, no IO — so replay stays clean.
 * maximumAttempts: 1 keeps MAX_DELETIONS the true per-execution destructive
 * bound; the daily schedule is the retry cadence.
 */

import { proxyActivities } from "@temporalio/workflow";
import type * as activities from "../activities/attachment-retention-purge";

const { purgeExpiredAttachmentsActivity } = proxyActivities<typeof activities>({
	startToCloseTimeout: "1 hour",
	heartbeatTimeout: "2 minutes",
	retry: {
		maximumAttempts: 1,
	},
});

export async function attachmentRetentionPurgeWorkflow(): Promise<
	Awaited<ReturnType<typeof purgeExpiredAttachmentsActivity>>
> {
	return await purgeExpiredAttachmentsActivity();
}
