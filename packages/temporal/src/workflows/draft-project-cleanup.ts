/**
 * `draftProjectCleanupWorkflow` — Unified Context Uploader Wizard.
 *
 * NEW daily cron that sweeps DRAFT `Project` rows abandoned past the 14-day
 * cutoff. Cancels in-flight LINK crawls per DRAFT before soft-deleting the
 * row.
 *
 * Sibling pattern to the existing hourly `wizardCleanupWorkflow` (which
 * only handles `WizardTempContext` file rows). Different cadence (hourly
 * vs daily) and different ownership semantics (temp-file expiry vs
 * abandoned DRAFT detection) made retrofitting the existing workflow
 * the wrong shape.
 *
 * Workflow body is intentionally trivial:
 *   - one activity call per cron fire,
 *   - no `Date.now()`, no `Math.random()`, no `Math.floor()` of anything
 *     workflow-clock-derived,
 *   - no branching on per-attempt timestamps.
 *
 * All side-effecting work (DB query, Temporal cancel, soft-delete) lives
 * in the activity per `fabric/standards/backend/temporal.md`.
 *
 * Schedule registration: `registerDraftProjectCleanupSchedule()` in
 * `packages/temporal/src/schedules.ts` (registered from
 * `registerSystemSchedules()`).
 */

import { log, proxyActivities } from "@temporalio/workflow";
import type * as activities from "../activities";

const { cleanupAbandonedDraftsActivity } = proxyActivities<typeof activities>({
	// 10-minute hard cap. Sweep handles batch of 50 DRAFTs +
	// per-row Temporal cancel; well within budget.
	startToCloseTimeout: "10m",
	heartbeatTimeout: "30 seconds",
	retry: {
		initialInterval: "5s",
		backoffCoefficient: 2,
		maximumAttempts: 3,
	},
});

export interface DraftProjectCleanupWorkflowInput {
	/** Default = 14 days. Lower bound enforced inside the activity. */
	cutoffDays?: number;
	/** Default = 50 DRAFTs per run. */
	batchSize?: number;
}

export interface DraftProjectCleanupWorkflowOutput {
	draftsDeleted: number;
	workflowsCancelled: number;
	errors: Array<{
		id: string;
		kind: "cancel" | "soft-delete";
		message: string;
	}>;
}

/**
 * Cleanup workflow for abandoned wizard DRAFTs.
 *
 * Daily cron at 03:00 UTC. Idempotent — re-running just finds whatever
 * still qualifies under the cutoff at the new `now`.
 */
export async function draftProjectCleanupWorkflow(
	input: DraftProjectCleanupWorkflowInput = {},
): Promise<DraftProjectCleanupWorkflowOutput> {
	log.info("Starting draft-project cleanup", {
		cutoffDays: input.cutoffDays,
		batchSize: input.batchSize,
	});

	const result = await cleanupAbandonedDraftsActivity({
		cutoffDays: input.cutoffDays,
		batchSize: input.batchSize,
	});

	if (result.errors.length > 0) {
		log.warn("Draft-project cleanup completed with errors", {
			draftsDeleted: result.draftsDeleted,
			workflowsCancelled: result.workflowsCancelled,
			errorCount: result.errors.length,
			// Log first 5 errors only to keep workflow history compact —
			// the activity logs the full set inline at error time.
			errors: result.errors.slice(0, 5),
		});
	} else {
		log.info("Draft-project cleanup completed successfully", {
			draftsDeleted: result.draftsDeleted,
			workflowsCancelled: result.workflowsCancelled,
		});
	}

	return result;
}
