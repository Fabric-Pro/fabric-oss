/**
 * Attachment Temp-Orphan Sweep Workflow.
 *
 * Scheduled daily (unconditional; see packages/temporal/src/schedules.ts).
 * Delegates entirely to `sweepAttachmentTempOrphansActivity`. The workflow body is deterministic — no
 * Date.now(), no env reads, no IO — so replay stays clean (CLAUDE.md replay
 * rule; CI replay validation fires on workflows/** changes).
 */

import { proxyActivities } from "@temporalio/workflow";
import type * as activities from "../activities/attachment-temp-orphan-sweep";

const { sweepAttachmentTempOrphansActivity } = proxyActivities<
	typeof activities
>({
	startToCloseTimeout: "15 minutes",
	retry: {
		initialInterval: "30 seconds",
		maximumInterval: "5 minutes",
		backoffCoefficient: 2,
		maximumAttempts: 3,
	},
});

export async function attachmentTempOrphanSweepWorkflow(): Promise<
	Awaited<ReturnType<typeof sweepAttachmentTempOrphansActivity>>
> {
	return await sweepAttachmentTempOrphansActivity();
}
