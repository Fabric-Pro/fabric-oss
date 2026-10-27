import { defineSignal, setHandler } from "@temporalio/workflow";
import { installApprovalController } from "../../approval-controller";
import { createInitialState } from "../../types";

/** Exercises the production controller in a real Temporal isolate. */
export async function approvalWorkflow() {
	const input = {
		userId: "example-user",
		organizationId: "example-org",
		executionId: "approval-test",
		executionMode: "balanced" as const,
		message: "Example",
		history: [],
	};
	const state = createInitialState(input);
	const controller = installApprovalController(state, input, 60_000);
	setHandler(defineSignal("cancel"), () => {
		state.cancelled = true;
	});
	const decisions = [];
	for (let i = 1; i <= 2; i++) {
		state.pendingApproval = {
			approvalId: `approval-${i}`,
			stepId: `step-${i}`,
			reason: "Review action",
		};
		decisions.push(
			await controller.waitForApproval({ requireExplicitDecision: true }),
		);
		state.pendingApproval = null;
		if (state.cancelled) {
			break;
		}
	}
	return decisions;
}
