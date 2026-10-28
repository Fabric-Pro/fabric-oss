import type {
	ApprovalSignalData,
	PendingApprovalInfo,
	WorkflowState,
} from "./types";

export interface ApprovalCommand {
	approvalId: string;
	requestId: string;
	runId: string;
	organizationId: string;
	decidedBy: string;
	approved: boolean;
	feedback?: string;
}

export type ApprovalReceipt =
	| { accepted: true; approvalId: string; approved: boolean }
	| {
			accepted: false;
			reason: "forbidden" | "stale" | "expired" | "decided";
	  };

/**
 * A single-use checkpoint. The workflow owns the clock and persists every
 * decision in Temporal history. No I/O or framework dependencies live here.
 */
export function createApprovalGate(
	state: Pick<
		WorkflowState,
		"pendingApproval" | "approvalDecision" | "cancelled" | "approvalHistory"
	>,
	owner: { userId: string; organizationId?: string | null; runId: string },
	now: () => number,
) {
	let sequence = 0;
	let active: PendingApprovalInfo | null = null;
	let explicit = false;
	let consumed = false;
	let openedAt = "";

	return {
		open(
			timeoutMs: number,
			requireExplicitDecision: boolean,
			preserveDecision = false,
		) {
			if (!preserveDecision) {
				state.approvalDecision = null;
			}
			active = state.pendingApproval;
			openedAt = new Date(now()).toISOString();
			explicit = requireExplicitDecision;
			consumed = state.approvalDecision !== null;
			if (active) {
				active.requestId = `${owner.runId}:${++sequence}`;
				active.runId = owner.runId;
				active.expiresAt = now() + timeoutMs;
			}
		},
		pending() {
			return active &&
				state.pendingApproval === active &&
				!consumed &&
				!state.cancelled
				? active
				: null;
		},
		close() {
			active = null;
		},
		decide(command: ApprovalCommand): ApprovalReceipt {
			if (
				!owner.organizationId ||
				command.organizationId !== owner.organizationId ||
				command.decidedBy !== owner.userId
			) {
				return { accepted: false, reason: "forbidden" };
			}
			if (
				!active ||
				state.cancelled ||
				state.pendingApproval !== active ||
				command.runId !== owner.runId ||
				command.requestId !== active.requestId ||
				command.approvalId !== active.approvalId ||
				typeof command.approved !== "boolean" ||
				(command.feedback !== undefined &&
					(typeof command.feedback !== "string" ||
						command.feedback.length > 10_000))
			) {
				return { accepted: false, reason: "stale" };
			}
			if (consumed) {
				return { accepted: false, reason: "decided" };
			}
			if (!active.expiresAt || now() >= active.expiresAt) {
				return { accepted: false, reason: "expired" };
			}
			consumed = true;
			state.approvalDecision = {
				approved: command.approved,
				feedback: command.feedback,
				decidedBy: command.decidedBy,
			};
			const decidedAt = new Date(now()).toISOString();
			const existing = state.approvalHistory.find(
				(entry) => entry.approvalId === active?.approvalId,
			);
			if (existing) {
				Object.assign(existing, {
					approved: command.approved,
					feedback: command.feedback,
					decidedAt,
				});
			} else {
				state.approvalHistory.push({
					approvalId: active.approvalId,
					stepId: active.stepId,
					stepDescription: active.reason,
					riskLevel:
						active.reason
							.match(/^(LOW|MEDIUM|HIGH|CRITICAL) RISK/i)?.[1]
							.toLowerCase() ?? "unknown",
					requestedAt: openedAt,
					decidedAt,
					approved: command.approved,
					feedback: command.feedback,
				});
			}
			return {
				accepted: true,
				approvalId: active.approvalId,
				approved: command.approved,
			};
		},
		autoApprove() {
			if (
				active &&
				!explicit &&
				!consumed &&
				!state.cancelled &&
				now() < (active.expiresAt ?? 0)
			) {
				consumed = true;
				state.approvalDecision = {
					approved: true,
					feedback: "Auto-approved (approve all)",
				} satisfies ApprovalSignalData;
			}
		},
	};
}
