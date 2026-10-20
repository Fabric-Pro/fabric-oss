/**
 * Which `approval` signals a run takes as the person's answer, and what
 * settles an approval wait.
 *
 * The workflow keeps a decision until the next approval wait consumes it, so
 * an answer that arrives when nothing is pending — a repeated click, a
 * retried POST, a second tab answering a card the first already answered —
 * would otherwise approve whatever the run asks next, without the person
 * seeing it. A decision counts only while an approval is pending and, when
 * the signal names one, only for that approval.
 *
 * Workflow code: pure, no I/O.
 */

import type { ApprovalSignalData, PendingApprovalInfo } from "../types";

/**
 * Patches whose rule is now unconditional. Each is called through
 * `deprecatePatch` at the point it used to be `patched()`: new runs record no
 * marker, and histories that recorded one still replay. Delete the calls and
 * these ids once no execution older than 2026-10-17 can still be replayed (the
 * replay-validation job fetches three days of dev histories).
 */
export const APPROVAL_SIGNAL_BOUND_PATCH =
	"orchestrator-approval-signal-bound-v1";
export const AUTHORITY_EXPLICIT_APPROVAL_PATCH =
	"orchestrator-authority-explicit-approval-v1";

export function approvalSignalAnswersPending(
	pending: Pick<PendingApprovalInfo, "approvalId"> | null,
	signal: Pick<ApprovalSignalData, "approvalId">,
): boolean {
	return (
		pending !== null &&
		(signal.approvalId === undefined ||
			signal.approvalId === pending.approvalId)
	);
}

/**
 * The answer that settles an approval wait, or `null` while it must keep
 * waiting. The person's own answer always wins. "Approve all" settles the
 * wait whether it was on before the checkpoint or arrives during it — except
 * for a checkpoint that requires an explicit decision, which only the
 * person's answer can settle.
 */
export function resolveApprovalWait(input: {
	decision: ApprovalSignalData | null;
	autoApproveAll: boolean;
	requireExplicitDecision: boolean;
}): ApprovalSignalData | null {
	if (input.decision !== null) {
		return input.decision;
	}
	if (input.autoApproveAll && !input.requireExplicitDecision) {
		return { approved: true, feedback: "Auto-approved (approve all)" };
	}
	return null;
}
