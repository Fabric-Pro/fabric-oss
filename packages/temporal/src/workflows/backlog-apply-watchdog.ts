/**
 * Backlog Apply Watchdog Workflow
 *
 * Cron-driven safety net for `PendingBacklogProposal` rows stuck mid-apply:
 * still PENDING with an apply dispatched (`applyStartedAt` set) longer than the
 * configured ceiling. This happens when the apply workflow was force-terminated
 * (OOM, worker crash, execution-timeout) before its finalize step ran, or was
 * scheduled but never picked up by a worker — either way the proposal leaks in
 * PENDING forever and the user has no terminal state to retry / dismiss from.
 *
 * Runs every 5 minutes on the `fabric-worker` queue, fetches up to `batchSize`
 * stuck proposals, force-terminates each leaked apply workflow, then flips the
 * row `PENDING → FAILED` (compare-and-set, so a late finalize / manual cancel
 * can't be clobbered) and writes a `backlog.proposal.timed_out` audit entry.
 *
 * Mirrors `weaveExecutionWatchdogWorkflow`.
 */

import { log, proxyActivities } from "@temporalio/workflow";
import type * as activities from "../activities";

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
	 * Proposals whose apply was dispatched (`applyStartedAt`) more than this
	 * many minutes ago and are still PENDING are considered stuck. Defaults to
	 * `FABRIC_BACKLOG_APPLY_STALE_MINUTES` (or 15 when unset). The default
	 * applies even when the caller passes `0` — that would otherwise nuke every
	 * in-flight apply, which is never what we want from a scheduled cron.
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
			// Terminate the leaked apply workflow FIRST so it can't finalize
			// after we flip the row (best-effort — it's usually already dead).
			if (row.workflowId) {
				await terminateBacklogApplyWorkflowActivity({
					workflowId: row.workflowId,
					reason: "backlog_apply_watchdog_stale",
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
