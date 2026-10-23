/**
 * Stuck-Apply Watchdog Activities
 *
 * The activities behind `backlogApplyWatchdogWorkflow` — the 5-minute cron that
 * recovers stale dispatched PENDING and claimed APPROVED/APPLYING proposals.
 * A workflow can terminate before finalize, or a claim can fail before dispatch;
 * the watchdog moves these rows to FAILED so the inbox offers Retry / Dismiss.
 *
 * Activity boundary: every Prisma write and Temporal client call lives here,
 * NOT in the workflow, so the workflow stays replay-safe under the post-1.16
 * SDK rules. Mirrors `weave/watchdog-activities.ts`.
 */

import {
	finalizeBacklogUpdateSession,
	findStaleApplyingProposals,
	recordAudit,
	timeOutStaleApply,
} from "@repo/database";
import type { Client } from "@temporalio/client";
import { getTemporalClient } from "../client";

/**
 * Default inactivity ceiling for dispatched PENDING and claimed
 * APPROVED/APPLYING proposals. Override per deployment via
 * `FABRIC_BACKLOG_APPLY_STALE_MINUTES`.
 */
const DEFAULT_STALE_MINUTES = 15;

function staleApplyCutoff(staleAfterMinutes = 0): Date {
	const envCeiling = Number.parseInt(
		process.env.FABRIC_BACKLOG_APPLY_STALE_MINUTES ?? "",
		10,
	);
	const baselineMinutes =
		Number.isFinite(envCeiling) && envCeiling > 0
			? envCeiling
			: DEFAULT_STALE_MINUTES;
	const effectiveMinutes =
		staleAfterMinutes > baselineMinutes
			? staleAfterMinutes
			: baselineMinutes;
	return new Date(Date.now() - effectiveMinutes * 60_000);
}

export interface StaleApplyProposal {
	proposalId: string;
	projectId: string;
	organizationId: string | null;
	workflowId: string | null;
	/** Latest apply/review activity, falling back to creation time (legacy field name). */
	applyStartedAtMs: number;
}

export interface FindStaleApplyingProposalsInput {
	/** May raise the env/default ceiling; smaller values use that ceiling. */
	staleAfterMinutes: number;
	batchSize: number;
}

export interface FindStaleApplyingProposalsOutput {
	rows: StaleApplyProposal[];
}

/**
 * Find stale dispatched PENDING and claimed APPROVED/APPLYING rows.
 * The input can only raise the env/default inactivity ceiling, so discovery
 * does not select younger rows than the timeout write permits. Environment
 * reads stay in activities; the default ceiling is 15 minutes.
 */
export async function findStaleApplyingProposalsActivity(
	input: FindStaleApplyingProposalsInput,
): Promise<FindStaleApplyingProposalsOutput> {
	const cutoff = staleApplyCutoff(input.staleAfterMinutes);

	const stale = await findStaleApplyingProposals({
		cutoff,
		limit: input.batchSize > 0 ? input.batchSize : 50,
	});

	return {
		rows: stale.map<StaleApplyProposal>((r) => ({
			proposalId: r.id,
			projectId: r.projectId,
			organizationId: r.organizationId,
			workflowId: r.applyWorkflowId,
			applyStartedAtMs: Math.max(
				r.applyStartedAt?.getTime() ?? r.createdAt.getTime(),
				r.reviewedAt?.getTime() ?? r.createdAt.getTime(),
			),
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
 * Flip stale PENDING/APPROVED/APPLYING proposals to FAILED via the atomic guard,
 * mirror the terminal status onto its session-history row, and write a
 * `backlog.proposal.timed_out` audit entry — but ONLY when this watchdog
 * actually won the transition (`timeOutStaleApply` returned 1). When the
 * guard prevents the update (the apply workflow's own finalize raced us, or a
 * manual cancel or fresh claim beat us), skip session-finalize and audit.
 *
 * @returns true when the watchdog stopped the proposal, false when it was
 * no longer stale.
 */
export async function markBacklogProposalTimedOutActivity(
	input: MarkBacklogProposalTimedOutInput,
): Promise<boolean> {
	const stopped = await timeOutStaleApply({
		proposalId: input.proposalId,
		cutoff: staleApplyCutoff(),
		errorClass: "TimedOut",
		errorMessage:
			"Apply timed out and was automatically stopped. You can retry it.",
	});
	if (stopped === 0) {
		// The row no longer meets the stale guard (finalize, cancel, or fresh claim).
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
