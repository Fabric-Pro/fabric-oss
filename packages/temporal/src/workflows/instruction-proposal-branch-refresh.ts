import {
	log,
	patched,
	proxyActivities,
	workflowInfo,
} from "@temporalio/workflow";
import type * as branchActivities from "../activities/instruction-proposal-branches";
import type * as proposalActivities from "../activities/instruction-proposal-pull-requests";
import type { ReconcileBranchResult } from "../activities/lib/instruction-branch-types";
import { INSTRUCTION_SYNC_ACTIVITY_TASK_QUEUE } from "../task-queues";

export const PROPOSAL_BRANCH_REFRESH_TERMINAL_WAKE_PATCH =
	"instruction-proposal-branch-refresh-terminal-wake-v1";

const { reconcileInstructionProposalBranch } = proxyActivities<
	typeof branchActivities
>({
	taskQueue: "project-instructions",
	// A credential exchange reserves 30 seconds and the activity's deadline
	// keeps a 10-second margin; leave room for that exchange and one GET.
	startToCloseTimeout: "60 seconds",
	heartbeatTimeout: "20 seconds",
	retry: { maximumAttempts: 1 },
});

/**
 * The wake's start-to-close. A proposal activity stops issuing effects 10
 * seconds before its timeout (`withProposalDeadline`), so this leaves 10
 * seconds for one `signalWithStart`; 10 seconds here left none.
 */
export const PROPOSAL_BRANCH_REFRESH_WAKE_TIMEOUT_MS = 20_000;

const { wakeInstructionProposalBranch } = proxyActivities<
	typeof proposalActivities
>({
	taskQueue: INSTRUCTION_SYNC_ACTIVITY_TASK_QUEUE,
	startToCloseTimeout: PROPOSAL_BRANCH_REFRESH_WAKE_TIMEOUT_MS,
	retry: { maximumAttempts: 1 },
});

/** Whether the run's execution timeout still leaves room for a whole wake. */
function wakeFits(): boolean {
	const expiresAt = workflowInfo().executionExpirationTime;
	return (
		expiresAt === undefined ||
		expiresAt.getTime() - Date.now() >=
			PROPOSAL_BRANCH_REFRESH_WAKE_TIMEOUT_MS
	);
}

export type ProposalBranchRefreshWorkflowInput = {
	branchId: string;
	/** Sent by current callers; absent in pre-patch histories and older API runs. */
	projectId?: string;
	organizationId: string;
	expectedAttempt: number;
};

/** One bounded, explicit provider observation; passive polling never starts this. */
export async function projectInstructionProposalBranchRefreshWorkflow(
	input: ProposalBranchRefreshWorkflowInput,
): Promise<ReconcileBranchResult> {
	const terminalWake = patched(PROPOSAL_BRANCH_REFRESH_TERMINAL_WAKE_PATCH);
	const result = await reconcileInstructionProposalBranch(input);
	// The sweeper wakes a terminal branch on its next tick anyway, so this wake
	// only makes it immediate: a run an older API started without a project id,
	// a slow observation that left no room for the wake, or a wake that fails,
	// still answers with the recorded observation.
	if (
		terminalWake &&
		input.projectId !== undefined &&
		(result.state === "CLOSED" || result.state === "MERGED") &&
		wakeFits()
	) {
		try {
			await wakeInstructionProposalBranch({
				branchId: input.branchId,
				projectId: input.projectId,
				organizationId: input.organizationId,
			});
		} catch (error) {
			log.warn(
				"Proposal branch refresh could not wake the branch workflow; the sweeper will",
				{ error: error instanceof Error ? error.name : typeof error },
			);
		}
	}
	return result;
}
