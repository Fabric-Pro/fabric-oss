/**
 * Frozen pre-terminal-wake refresh workflow for replay validation. It records
 * only the provider observation, as staging did before the terminal branch
 * wake patch. Do not update it with the current workflow.
 */
import { proxyActivities } from "@temporalio/workflow";
import type * as branchActivities from "../../../src/activities/instruction-proposal-branches";
import type { ReconcileBranchResult } from "../../../src/activities/lib/instruction-branch-types";

const { reconcileInstructionProposalBranch } = proxyActivities<
	typeof branchActivities
>({
	taskQueue: "project-instructions",
	startToCloseTimeout: "60 seconds",
	heartbeatTimeout: "20 seconds",
	retry: { maximumAttempts: 1 },
});

type LegacyProposalBranchRefreshWorkflowInput = {
	branchId: string;
	organizationId: string;
	expectedAttempt: number;
};

export async function projectInstructionProposalBranchRefreshWorkflow(
	input: LegacyProposalBranchRefreshWorkflowInput,
): Promise<ReconcileBranchResult> {
	return reconcileInstructionProposalBranch(input);
}
