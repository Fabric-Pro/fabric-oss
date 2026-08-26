/**
 * Attachment Final-Orphan Sweep Workflow.
 *
 * Scheduled daily (unconditional; see packages/temporal/src/schedules.ts).
 * Delegates entirely to `sweepAttachmentFinalOrphansActivity`. The workflow body is deterministic — no
 * Date.now(), no env reads, no IO — so replay stays clean (CLAUDE.md replay
 * rule; CI replay validation fires on workflows/** changes).
 *
 * `maximumAttempts: 1`: a daily integrity backstop needs no sub-run
 * retry — the schedule's daily cadence is the retry. A single attempt keeps
 * MAX_DELETIONS the TRUE per-execution destructive bound (a retry would reset
 * the budget and could delete up to cap×attempts distinct orphans per
 * execution). A transient listObjects/findMany failure fails the run (visible to
 * monitoring) and is recovered by the next daily run.
 */

import { proxyActivities } from "@temporalio/workflow";
import type * as activities from "../activities/attachment-final-orphan-sweep";

const { sweepAttachmentFinalOrphansActivity } = proxyActivities<
	typeof activities
>({
	startToCloseTimeout: "1 hour",
	heartbeatTimeout: "2 minutes",
	retry: {
		maximumAttempts: 1,
	},
});

export async function attachmentFinalOrphanSweepWorkflow(): Promise<
	Awaited<ReturnType<typeof sweepAttachmentFinalOrphansActivity>>
> {
	return await sweepAttachmentFinalOrphansActivity();
}
