/**
 * Stuck-Apply Watchdog Activities
 *
 * The activities behind `backlogApplyWatchdogWorkflow` — the 5-minute cron that
 * recovers `PendingBacklogProposal` rows stuck mid-apply: still PENDING with an
 * apply dispatched (`applyStartedAt` set) longer than the configured ceiling.
 * This happens when the apply workflow was force-terminated (OOM, worker crash,
 * execution-timeout) before its finalize step ran, OR was scheduled but never
 * picked up by a worker — either way the row leaks in PENDING forever and the
 * user is stuck with no terminal state to retry / dismiss from.
 *
 * Activity boundary: every Prisma write and Temporal client call lives here,
 * NOT in the workflow, so the workflow stays replay-safe under the post-1.16
 * SDK rules. Mirrors `weave/watchdog-activities.ts`.
 */

import {
	finalizeBacklogUpdateSession,
	findStaleApplyingProposals,
	recordAudit,
	stopApplyingProposal,
} from "@repo/database";
import type { Client } from "@temporalio/client";
import { getTemporalClient } from "../client";

/**
 * Default ceiling: a proposal whose apply was dispatched more than this many
 * minutes ago and is still PENDING is considered stuck. Conservative on
 * purpose — a large batch syncing to a PM tool can legitimately run a few
 * minutes, so 15 only catches genuinely-dead applies. Override per-deployment
 * via `FABRIC_BACKLOG_APPLY_STALE_MINUTES`.
 */
const DEFAULT_STALE_MINUTES = 15;

export interface StaleApplyProposal {
	proposalId: string;
	projectId: string;
	organizationId: string | null;
	workflowId: string | null;
	applyStartedAtMs: number;
}

export interface FindStaleApplyingProposalsInput {
	staleAfterMinutes: number;
	batchSize: number;
}

export interface FindStaleApplyingProposalsOutput {
	rows: StaleApplyProposal[];
}

/**
 * Find proposals stuck mid-apply. Reads `FABRIC_BACKLOG_APPLY_STALE_MINUTES`
 * from env when `input.staleAfterMinutes` is 0 / negative, so the workflow body
 * stays free of `process.env` reads (non-deterministic in Temporal workflows
 * under SDK 1.16 + reuseV8Context). Defaults to 15 minutes.
 */
export async function findStaleApplyingProposalsActivity(
	input: FindStaleApplyingProposalsInput,
): Promise<FindStaleApplyingProposalsOutput> {
	const envCeiling = Number.parseInt(
		process.env.FABRIC_BACKLOG_APPLY_STALE_MINUTES ?? "",
		10,
	);
	const effectiveMinutes =
		input.staleAfterMinutes > 0
			? input.staleAfterMinutes
			: Number.isFinite(envCeiling) && envCeiling > 0
				? envCeiling
				: DEFAULT_STALE_MINUTES;
	const cutoff = new Date(Date.now() - effectiveMinutes * 60_000);

	const stale = await findStaleApplyingProposals({
		cutoff,
		limit: input.batchSize > 0 ? input.batchSize : 50,
	});

	return {
		rows: stale
			.filter((r) => r.applyStartedAt !== null)
			.map<StaleApplyProposal>((r) => ({
				proposalId: r.id,
				projectId: r.projectId,
				organizationId: r.organizationId,
				workflowId: r.applyWorkflowId,
				// biome-ignore lint/style/noNonNullAssertion: filtered above
				applyStartedAtMs: r.applyStartedAt!.getTime(),
			})),
	};
}

export interface TerminateBacklogApplyWorkflowInput {
	workflowId: string;
	reason: string;
}

/**
 * Force-terminate the leaked apply workflow. Idempotent: a workflow that's
 * already terminal / never existed is a no-op (swallowed). Mirrors
 * `terminateWeaveWorkflow`.
 */
export async function terminateBacklogApplyWorkflowActivity(
	input: TerminateBacklogApplyWorkflowInput,
): Promise<void> {
	let client: Client;
	try {
		client = await getTemporalClient();
	} catch {
		return;
	}
	try {
		await client.workflow
			.getHandle(input.workflowId)
			.terminate(input.reason);
	} catch {
		// Already terminal / non-existent — fine.
	}
}

export interface MarkBacklogProposalTimedOutInput {
	proposalId: string;
	projectId: string;
	organizationId: string | null;
	applyDurationMs: number;
}

/**
 * Flip the stuck proposal `PENDING → FAILED` via the compare-and-set helper,
 * mirror the terminal status onto its session-history row, and write a
 * `backlog.proposal.timed_out` audit entry — but ONLY when this watchdog
 * actually won the transition (`stopApplyingProposal` returned 1). When the
 * guard prevents the update (the apply workflow's own finalize raced us, or a
 * manual cancel beat us), we skip the session-finalize and audit so we never
 * emit a misleading duplicate.
 *
 * @returns true when the watchdog stopped the proposal, false when it was
 * already terminal.
 */
export async function markBacklogProposalTimedOutActivity(
	input: MarkBacklogProposalTimedOutInput,
): Promise<boolean> {
	const stopped = await stopApplyingProposal({
		proposalId: input.proposalId,
		errorClass: "TimedOut",
		errorMessage:
			"Apply timed out and was automatically stopped. You can retry it.",
	});
	if (stopped === 0) {
		// The apply workflow's finalize (or a manual cancel) already moved the
		// row out of PENDING — nothing leaked, so no session-finalize / audit.
		return false;
	}

	// Mirror the terminal status onto the session-history row (best-effort;
	// no-op when no session exists) so a stuck session doesn't sit in APPLYING.
	await finalizeBacklogUpdateSession({
		pendingProposalId: input.proposalId,
		status: "FAILED",
	}).catch(() => {
		// Non-fatal: a stuck session row only affects the history tab.
	});

	recordAudit({
		action: "backlog.proposal.timed_out",
		category: "backlog",
		severity: "warning",
		outcome: "success",
		actor: { type: "system", nameSnapshot: "backlog-apply-watchdog" },
		organizationId: input.organizationId,
		projectId: input.projectId,
		resource: { type: "backlog_proposal", id: input.proposalId },
		metadata: {
			applyDurationMs: input.applyDurationMs,
			reason: "killed by watchdog: exceeded FABRIC_BACKLOG_APPLY_STALE_MINUTES",
		},
	});

	return true;
}
