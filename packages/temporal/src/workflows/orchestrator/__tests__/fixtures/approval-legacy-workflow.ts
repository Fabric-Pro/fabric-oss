import {
	condition,
	defineQuery,
	defineSignal,
	deprecatePatch,
	log,
	setHandler,
} from "@temporalio/workflow";
import {
	APPROVAL_SIGNAL_BOUND_PATCH,
	AUTHORITY_EXPLICIT_APPROVAL_PATCH,
	approvalSignalAnswersPending,
	resolveApprovalWait,
} from "../../phases/approval-signal";
import type { ApprovalSignalData, PendingApprovalInfo } from "../../types";
// Handler and wait bodies copied from a53ed9614 orchestrator/index.ts.
export async function approvalWorkflow(
	_inputProtocol?: 2,
	requireExplicitDecision = true,
) {
	const state: {
		pendingApproval: PendingApprovalInfo | null;
		approvalDecision: ApprovalSignalData | null;
		autoApproveAll: boolean;
		cancelled: boolean;
	} = {
		pendingApproval: null,
		approvalDecision: null,
		autoApproveAll: false,
		cancelled: false,
	};
	const approvalSignal = defineSignal<[ApprovalSignalData]>("approval");
	const autoApproveAllSignal = defineSignal("autoApproveAll");
	const revokeAutoApproveSignal = defineSignal("revokeAutoApprove");
	const waitTimeoutMs = () => 60_000;
	setHandler(defineQuery("pendingApproval"), () => state.pendingApproval);
	setHandler(approvalSignal, (data) => {
		log.info("Received approval signal", {
			approved: data.approved,
			feedback: data.feedback,
		});
		deprecatePatch(APPROVAL_SIGNAL_BOUND_PATCH);
		if (!approvalSignalAnswersPending(state.pendingApproval, data)) {
			log.warn(
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

	// Only sets the flag: `waitForApproval` decides whether it settles the
	// pending checkpoint, so it cannot answer one that needs an explicit click.
	setHandler(autoApproveAllSignal, () => {
		log.info(
			"Received auto-approve-all signal — checkpoints will be auto-approved",
		);
		state.autoApproveAll = true;
	});

	setHandler(revokeAutoApproveSignal, () => {
		log.info(
			"Received revoke-auto-approve signal — future checkpoints will require human review again",
		);
		state.autoApproveAll = false;
	});

	async function waitForApproval(options?: {
		requireExplicitDecision?: boolean;
	}): Promise<ApprovalSignalData | null> {
		// Runtime-authority checkpoints opt out of approve-all: granting a
		// provider WRITE session is not a plan-step approval and must be an
		// explicit click.
		const requireExplicitDecision =
			options?.requireExplicitDecision === true;
		if (requireExplicitDecision) {
			deprecatePatch(AUTHORITY_EXPLICIT_APPROVAL_PATCH);
		}
		const settled = () =>
			resolveApprovalWait({
				decision: state.approvalDecision,
				autoApproveAll: state.autoApproveAll,
				requireExplicitDecision,
			});

		if (state.autoApproveAll && requireExplicitDecision) {
			log.info(
				"Authority checkpoint requires an explicit decision; approve-all does not apply",
			);
		}

		if (settled() === null) {
			await condition(
				() => settled() !== null || state.cancelled,
				waitTimeoutMs(),
			);
		}
		if (state.cancelled) {
			return null;
		}

		const decision = settled();
		if (decision !== null && state.approvalDecision === null) {
			log.info("Auto-approving checkpoint (approve-all active)");
		}
		state.approvalDecision = null;
		return decision;
	}

	const decisions = [];
	for (let i = 1; i <= 2; i++) {
		state.pendingApproval = {
			approvalId: `approval-${i}`,
			stepId: `step-${i}`,
			reason: "Review action",
		};
		decisions.push(await waitForApproval({ requireExplicitDecision }));
		state.pendingApproval = null;
	}
	return decisions;
}
