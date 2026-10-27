import {
	condition,
	defineQuery,
	defineSignal,
	patched,
	setHandler,
} from "@temporalio/workflow";
import type { ApprovalSignalData, PendingApprovalInfo } from "../../types";

/** Historical signal/condition contract, before acknowledged approval updates. */
export async function approvalWorkflow() {
	let pending: PendingApprovalInfo | null = null;
	let decision: ApprovalSignalData | null = null;
	setHandler(defineQuery("pendingApproval"), () => pending);
	setHandler(defineSignal<[ApprovalSignalData]>("approval"), (data) => {
		decision = data;
	});
	const decisions = [];
	for (let i = 1; i <= 2; i++) {
		pending = {
			approvalId: `approval-${i}`,
			stepId: `step-${i}`,
			reason: "Review action",
		};
		patched("orchestrator-authority-explicit-approval-v1");
		await condition(() => decision !== null, 60_000);
		decisions.push(decision);
		decision = null;
		pending = null;
	}
	return decisions;
}
