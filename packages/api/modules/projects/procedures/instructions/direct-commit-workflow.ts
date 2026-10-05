/**
 * Starting a direct commit's workflow (Fizzy #2878 §10), shared by the
 * inline entry point (`submit-change.ts`) and the revert procedure.
 *
 * `projectInstructionDirectCommitWorkflow` waits for the snapshot's own
 * validation to reach READY and then pushes one commit. Its id is derived
 * from the snapshot (`instructionDirectCommitWorkflowId`), so a repeated start
 * for one snapshot finds the open run instead of beginning a second commit.
 */
import { instructionDirectCommitWorkflowId } from "@repo/instructions";
import { getTemporalClient } from "@repo/temporal";
import { COMMIT_WORKFLOW_EXECUTION_TIMEOUT_MS } from "@repo/temporal/instruction-direct-commit-types";
import { withCorrelationMemo } from "../../../../lib/temporal-correlation";

/** The instructions worker's queue, shared with the snapshot and branch workflows. */
const DIRECT_COMMIT_TASK_QUEUE = "project-instructions";

/** The workflow's type, exact. */
const DIRECT_COMMIT_WORKFLOW_TYPE = "projectInstructionDirectCommitWorkflow";

/**
 * Starts the commit workflow for `snapshotId`. An execution that is already
 * open under the derived id means an earlier request started it (a retried
 * submission), which is the outcome wanted, so it is not a failure. Matched
 * by name: `@temporalio/client` is not a dependency of this package, the
 * rule `finalize.ts` follows. Any other failure is thrown: the caller owns a
 * snapshot row it must close out.
 *
 * The execution timeout bounds a workflow that nothing will finish (a wait
 * for validation that never ends, a record that keeps failing): a commit row
 * still pending after it has no workflow behind it, and the reaper closes it
 * (`STALE`).
 */
export async function startDirectCommitWorkflow(input: {
	snapshotId: string;
	organizationId: string;
}): Promise<void> {
	const client = await getTemporalClient();
	try {
		await client.workflow.start(
			DIRECT_COMMIT_WORKFLOW_TYPE,
			withCorrelationMemo({
				taskQueue: DIRECT_COMMIT_TASK_QUEUE,
				workflowId: instructionDirectCommitWorkflowId(input.snapshotId),
				workflowExecutionTimeout: COMMIT_WORKFLOW_EXECUTION_TIMEOUT_MS,
				args: [
					{
						snapshotId: input.snapshotId,
						organizationId: input.organizationId,
					},
				],
			}),
		);
	} catch (error) {
		if (
			!(
				error instanceof Error &&
				error.name === "WorkflowExecutionAlreadyStartedError"
			)
		) {
			throw error;
		}
	}
}
