/**
 * Starting a revert's workflow and waiting for its answer (Fizzy #2878 §10),
 * for `instructions.revertCommit`.
 *
 * `projectInstructionRevertCommitWorkflow` fetches the branch, builds one
 * revert commit and pushes it: seconds, not minutes. The request waits for the
 * result because the result is the answer to the member's click (a typed
 * refusal or the new commit). A revert that outlives the wait is not failed: it
 * keeps running, its commit carries the request's `Fabric-Commit` trailer, and
 * the caller is told it is `pending` so History can be refreshed.
 *
 * The workflow id is derived from the project (`instructionRevertCommitWorkflowId`)
 * and the start uses `workflowIdConflictPolicy: "FAIL"`: Temporal itself
 * refuses a second revert while one is open, answered as `in_progress`, because
 * two reverts of one branch would race for the same tip.
 */
import { instructionRevertCommitWorkflowId } from "@repo/instructions";
import { getTemporalClient } from "@repo/temporal";
import {
	COMMIT_WORKFLOW_EXECUTION_TIMEOUT_MS,
	type RevertCommitWorkflowInput,
	type RevertCommitWorkflowResult,
} from "@repo/temporal/instruction-direct-commit-types";
import { withCorrelationMemo } from "../../../../lib/temporal-correlation";

/** The instructions worker's queue, shared with the snapshot and branch workflows. */
const REVERT_TASK_QUEUE = "project-instructions";

/** The workflow's type, exact. */
const REVERT_WORKFLOW_TYPE = "projectInstructionRevertCommitWorkflow";

/** How long the request waits for the revert before answering `pending`. */
const REVERT_WAIT_MS = 60_000;

export type RevertCommitAnswer =
	| RevertCommitWorkflowResult
	| { kind: "pending" }
	/** Another revert of this project's branch is still open. */
	| { kind: "in_progress" };

export async function runRevertCommitWorkflow(
	input: RevertCommitWorkflowInput,
	waitMs: number = REVERT_WAIT_MS,
): Promise<RevertCommitAnswer> {
	const client = await getTemporalClient();
	const workflowId = instructionRevertCommitWorkflowId(input.projectId);
	let handle: Awaited<ReturnType<typeof client.workflow.start>>;
	try {
		handle = await client.workflow.start(
			REVERT_WORKFLOW_TYPE,
			withCorrelationMemo({
				taskQueue: REVERT_TASK_QUEUE,
				workflowId,
				workflowIdConflictPolicy: "FAIL",
				workflowExecutionTimeout: COMMIT_WORKFLOW_EXECUTION_TIMEOUT_MS,
				args: [input],
			}),
		);
	} catch (error) {
		// Matched by name: `@temporalio/client` is not a dependency of this
		// package, the rule `finalize.ts` and `direct-commit-workflow.ts` follow.
		if (
			error instanceof Error &&
			error.name === "WorkflowExecutionAlreadyStartedError"
		) {
			return { kind: "in_progress" };
		}
		throw error;
	}
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			handle.result() as Promise<RevertCommitWorkflowResult>,
			new Promise<{ kind: "pending" }>((resolve) => {
				timer = setTimeout(() => resolve({ kind: "pending" }), waitMs);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}
