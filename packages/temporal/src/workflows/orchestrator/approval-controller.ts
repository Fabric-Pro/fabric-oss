import {
	condition,
	defineQuery,
	defineSignal,
	defineUpdate,
	deprecatePatch,
	log,
	patched,
	setHandler,
	workflowInfo,
} from "@temporalio/workflow";
import {
	type ApprovalCommand,
	type ApprovalReceipt,
	createApprovalGate,
} from "./approval-gate";
import {
	APPROVAL_SIGNAL_BOUND_PATCH,
	AUTHORITY_EXPLICIT_APPROVAL_PATCH,
	approvalSignalAnswersPending,
	resolveApprovalWait,
} from "./phases/approval-signal";
import type {
	ApprovalSignalData,
	OrchestratorWorkflowInput,
	PendingApprovalInfo,
	WorkflowState,
} from "./types";

export const approvalSignal = defineSignal<[ApprovalSignalData]>("approval");
export const autoApproveAllSignal = defineSignal("autoApproveAll");
export const revokeAutoApproveSignal = defineSignal("revokeAutoApprove");
export const decideApprovalUpdate = defineUpdate<
	ApprovalReceipt,
	[ApprovalCommand]
>("decideApproval");
export const pendingApprovalQuery = defineQuery<PendingApprovalInfo | null>(
	"pendingApproval",
);

export function installApprovalController(
	state: WorkflowState,
	input: Pick<
		OrchestratorWorkflowInput,
		"userId" | "organizationId" | "approvalProtocol"
	>,
	timeoutMs: number | (() => number),
) {
	const resolveTimeoutMs = () =>
		typeof timeoutMs === "function" ? timeoutMs() : timeoutMs;
	const boundApprovals =
		input.approvalProtocol === 2 &&
		patched("orchestrator-bound-approvals-v1");
	const approvalGate = createApprovalGate(
		state,
		{
			userId: input.userId,
			organizationId: input.organizationId,
			runId: workflowInfo().runId,
		},
		Date.now,
	);
	// Update handlers and checkpoint metadata are command-free, so legacy
	// runs can accept bound decisions without changing their recorded timers.
	setHandler(decideApprovalUpdate, (command) => approvalGate.decide(command));

	setHandler(approvalSignal, (data) => {
		// A rolled-back API may signal a run started with protocol 2. Adapt the
		// signal to the active gate so it cannot bypass stale/consumed checks.
		if (boundApprovals && input.approvalProtocol === 2) {
			const pending = approvalGate.pending();
			if (
				!pending?.requestId ||
				!pending.runId ||
				!approvalSignalAnswersPending(pending, data)
			) {
				return;
			}
			approvalGate.decide({
				approvalId: pending.approvalId,
				requestId: pending.requestId,
				runId: pending.runId,
				organizationId: input.organizationId ?? "",
				decidedBy: data.decidedBy ?? input.userId,
				approved: data.approved,
				feedback: data.feedback,
			});
			return;
		}
		log.info("Received approval signal", {
			approved: data.approved,
			feedback: data.feedback,
		});
		deprecatePatch?.(APPROVAL_SIGNAL_BOUND_PATCH);
		if (!approvalSignalAnswersPending(state.pendingApproval, data)) {
			log.warn?.(
				"Ignored an approval signal that answers no pending approval",
				{
					approvalId: data.approvalId,
					pendingApprovalId: state.pendingApproval?.approvalId,
				},
			);
			return;
		}
		state.approvalDecision = data;
	});

	setHandler(autoApproveAllSignal, () => {
		log.info(
			"Received auto-approve-all signal — eligible checkpoints will be auto-approved",
		);
		state.autoApproveAll = true;
		// Also approve the current pending checkpoint if any
		if (boundApprovals) {
			approvalGate.autoApprove();
		}
	});

	setHandler(revokeAutoApproveSignal, () => {
		log.info(
			"Received revoke-auto-approve signal — future checkpoints will require human review again",
		);
		state.autoApproveAll = false;
	});

	setHandler(pendingApprovalQuery, () =>
		boundApprovals ? approvalGate.pending() : state.pendingApproval,
	);
	async function waitForApproval(options?: {
		requireExplicitDecision?: boolean;
	}): Promise<ApprovalSignalData | null> {
		// Staging deprecated this patch; retain its explicit-wait semantics on replay.
		const requireExplicitDecision =
			options?.requireExplicitDecision === true;
		if (requireExplicitDecision) {
			deprecatePatch(AUTHORITY_EXPLICIT_APPROVAL_PATCH);
		}
		if (!boundApprovals) {
			approvalGate.open(
				resolveTimeoutMs(),
				requireExplicitDecision,
				true,
			);
			const settled = () =>
				resolveApprovalWait({
					decision: state.approvalDecision,
					autoApproveAll: state.autoApproveAll,
					requireExplicitDecision,
				});
			if (settled() === null) {
				try {
					await condition(
						() => settled() !== null || state.cancelled,
						resolveTimeoutMs(),
					);
				} finally {
					approvalGate.close();
				}
			}
			if (state.cancelled) {
				return null;
			}
			const decision = settled();
			state.approvalDecision = null;
			return decision;
		}

		// Skip approval entirely when auto-approve-all is active
		if (state.autoApproveAll && !requireExplicitDecision) {
			log.info("Auto-approving checkpoint (approve-all active)");
			return { approved: true, feedback: "Auto-approved (approve all)" };
		}
		if (state.autoApproveAll && requireExplicitDecision) {
			log.info(
				"Authority checkpoint requires an explicit decision; approve-all does not apply",
			);
		}

		// Legacy histories can contain a signal buffered before this wait.
		// Preserve that decision on replay instead of introducing a new timer.
		const currentTimeoutMs = resolveTimeoutMs();
		approvalGate.open(
			currentTimeoutMs,
			requireExplicitDecision,
			!boundApprovals,
		);
		try {
			await condition(
				() => state.approvalDecision !== null || state.cancelled,
				currentTimeoutMs,
			);
		} finally {
			approvalGate.close();
		}
		if (state.cancelled) {
			return null;
		}

		const decision = state.approvalDecision;
		state.approvalDecision = null;
		return decision;
	}

	return { waitForApproval };
}
