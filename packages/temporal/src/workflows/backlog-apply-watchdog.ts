/**
 * Backlog Apply Watchdog Workflow
 *
 * Cron-driven safety net for stale dispatched PENDING and claimed
 * APPROVED/APPLYING proposals, including claims that did not reach dispatch.
 *
 * Runs every 5 minutes on the `fabric-worker` queue, fetches up to `batchSize`
 * stuck proposals, attempts to terminate each leaked apply workflow, then moves
 * still-stale rows to FAILED with an atomic database guard and writes a
 * `backlog.proposal.timed_out` audit entry for transitions it won.
 *
 * Mirrors `weaveExecutionWatchdogWorkflow`.
 */

import { log, proxyActivities } from "@temporalio/workflow";
import type * as activities from "../activities";
import { BACKLOG_APPLY_WATCHDOG_STOP_REASON } from "./backlog-constants";

const {
	findStaleApplyingProposalsActivity,
	terminateBacklogApplyWorkflowActivity,
	markBacklogProposalTimedOutActivity,
} = proxyActivities<typeof activities>({
	startToCloseTimeout: "2 minutes",
	retry: {
		initialInterval: "2s",
		backoffCoefficient: 2,
		maximumInterval: "30s",
		maximumAttempts: 3,
	},
});

export interface BacklogApplyWatchdogInput {
	/**
	 * Inactivity ceiling for dispatched PENDING and claimed APPROVED/APPLYING
	 * proposals. Defaults to FABRIC_BACKLOG_APPLY_STALE_MINUTES (or 15 when unset).
	 * The input can only raise that ceiling; smaller values use the default.
	 */
	staleAfterMinutes?: number;
	/** Max rows per tick — keeps each watchdog run bounded. */
	batchSize?: number;
}

export interface BacklogApplyWatchdogOutput {
	stopped: number;
	scanned: number;
}

export async function backlogApplyWatchdogWorkflow(
	input: BacklogApplyWatchdogInput = {},
): Promise<BacklogApplyWatchdogOutput> {
	// `process.env` reads are non-deterministic in Temporal workflows under
	// SDK 1.16 + reuseV8Context — so the env-or-default fallback for
	// `staleAfterMinutes` lives inside `findStaleApplyingProposalsActivity`.
	// Pass 0 / undefined here and the activity reads
	// `FABRIC_BACKLOG_APPLY_STALE_MINUTES` and defaults to 15.
	const staleAfterMinutes =
		input.staleAfterMinutes && input.staleAfterMinutes > 0
			? input.staleAfterMinutes
			: 0;
	const batchSize =
		input.batchSize && input.batchSize > 0 ? input.batchSize : 50;

	const stale = await findStaleApplyingProposalsActivity({
		staleAfterMinutes,
		batchSize,
	});

	let stopped = 0;

	for (const row of stale.rows) {
		try {
			// Attempt to terminate the leaked workflow before the guarded write
			// (best-effort — it may already be dead).
			if (row.workflowId) {
				await terminateBacklogApplyWorkflowActivity({
					workflowId: row.workflowId,
					reason: BACKLOG_APPLY_WATCHDOG_STOP_REASON,
				});
			}

			const killed = await markBacklogProposalTimedOutActivity({
				proposalId: row.proposalId,
				projectId: row.projectId,
				organizationId: row.organizationId,
				applyDurationMs: Date.now() - row.applyStartedAtMs,
			});
			if (killed) {
				stopped++;
			}
		} catch (err) {
			log.error("backlog_apply_watchdog_row_failed", {
				proposalId: row.proposalId,
				workflowId: row.workflowId,
				error: err instanceof Error ? err.message : String(err),
			});
			// Continue — one bad row must not stop the sweep.
		}
	}

	log.info("backlog_apply_watchdog_completed", {
		stopped,
		scanned: stale.rows.length,
		staleAfterMinutes,
		batchSize,
	});

	return { stopped, scanned: stale.rows.length };
}
