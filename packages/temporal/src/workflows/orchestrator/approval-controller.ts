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
	approvalSignalAnswersPending,
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
	input: Pick<OrchestratorWorkflowInput, "userId" | "organizationId">,
	timeoutMs: number | (() => number),
) {
	const resolveTimeoutMs = () =>
		typeof timeoutMs === "function" ? timeoutMs() : timeoutMs;
	const boundApprovals = patched("orchestrator-bound-approvals-v1");
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
		// Old histories retain their signal semantics. New runs require an
		// acknowledged Update; an unbound signal must never unblock a gate.
		if (boundApprovals) {
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
			"Received auto-approve-all signal — all future checkpoints will be auto-approved",
		);
		state.autoApproveAll = true;
		// Also approve the current pending checkpoint if any
		if (
			boundApprovals ||
			patched("orchestrator-authority-approve-all-signal-v2")
		) {
			approvalGate.autoApprove();
		} else if (state.pendingApproval && !state.approvalDecision) {
			state.approvalDecision = {
				approved: true,
				feedback: "Auto-approved (approve all)",
			};
		}
	});

	setHandler(revokeAutoApproveSignal, () => {
		log.info(
			"Received revoke-auto-approve signal — future checkpoints will require human review again",
		);
		state.autoApproveAll = false;
	});

	setHandler(pendingApprovalQuery, () => approvalGate.pending());
	async function waitForApproval(options?: {
		requireExplicitDecision?: boolean;
	}): Promise<ApprovalSignalData | null> {
		// Runtime-authority checkpoints opt out of approve-all: granting a
		// provider WRITE session is not a plan-step approval and must be an
		// explicit click. `patched()` is REQUIRED here — on this path the
		// function now blocks on `condition()` (a timer command) where
		// pre-patch histories returned immediately, so an unguarded change
		// would replay non-deterministically for runs that auto-approved an
		// authority checkpoint.
		const requireExplicitDecision =
			options?.requireExplicitDecision === true &&
			patched("orchestrator-authority-explicit-approval-v1");

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
