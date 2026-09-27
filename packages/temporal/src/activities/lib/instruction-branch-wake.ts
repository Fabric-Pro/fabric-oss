/**
 * Wakes a member proposal branch's workflow from inside `@repo/temporal`
 * (Fizzy #2738 spec §6 "Start", §8 "Wake"): the sweeper's Close, Recover,
 * Restart and Attach, and rehome waking the branches its proposals joined.
 *
 * The contract is the API's `wakeProposalBranchWorkflow`: workflow id
 * `project-instruction-proposal-branch-<branchId>`, type
 * `projectInstructionProposalBranchWorkflow`, task queue
 * `project-instructions`, signal `wake` with no arguments, and the input
 * `{branchId, projectId, organizationId}`. `signalWithStart` signals a
 * running workflow and starts one that is not. A wake from here originates
 * in no request, so it carries no correlation memo.
 *
 * Not re-exported from the activities barrel: every export of a module the
 * barrel re-exports becomes a schedulable Temporal activity.
 */
import { getTemporalClient } from "../../client";

/** The instructions workflow queue (spec §6 "Queues as #2563"). */
export const PROPOSAL_BRANCH_WORKFLOW_TASK_QUEUE = "project-instructions";

/** The branch workflow's type (spec §6, exact). */
export const PROPOSAL_BRANCH_WORKFLOW_TYPE =
	"projectInstructionProposalBranchWorkflow";

/** The signal that makes the branch workflow read its next work again. */
export const PROPOSAL_BRANCH_WAKE_SIGNAL = "wake";

/** The branch workflow's id (spec §6 "Identity", exact). */
export function proposalBranchWorkflowId(branchId: string): string {
	return `project-instruction-proposal-branch-${branchId}`;
}

/**
 * `signalWithStart(wake)` for one branch. `signal`, when given, cancels a
 * call in flight (the calling activity's cancellation or deadline).
 */
export async function wakeBranchWorkflow(
	ids: { branchId: string; projectId: string; organizationId: string },
	signal?: AbortSignal,
): Promise<void> {
	const client = await getTemporalClient();
	const start = () =>
		client.workflow.signalWithStart(PROPOSAL_BRANCH_WORKFLOW_TYPE, {
			taskQueue: PROPOSAL_BRANCH_WORKFLOW_TASK_QUEUE,
			workflowId: proposalBranchWorkflowId(ids.branchId),
			args: [
				{
					branchId: ids.branchId,
					projectId: ids.projectId,
					organizationId: ids.organizationId,
				},
			],
			signal: PROPOSAL_BRANCH_WAKE_SIGNAL,
			signalArgs: [],
		});
	await (signal ? client.withAbortSignal(signal, start) : start());
}
