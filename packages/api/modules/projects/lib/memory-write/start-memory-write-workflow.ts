/**
 * Starting a Living Memory write's workflow (ADR-022): the write is the
 * receipt `submit` stored, and the workflow does the git write and records how
 * it ended.
 *
 * `memoryWriteWorkflow` runs on the queue the Coding Instructions direct commit
 * workflow uses; its id is derived from the receipt (`memoryWriteWorkflowId`),
 * so a repeated start for one receipt finds the open run instead of beginning a
 * second write. The execution timeout bounds a workflow nothing will finish: a
 * receipt still `PENDING` after it has nothing behind it.
 */
import { memoryWriteWorkflowId } from "@repo/instructions/workflow-ids";
import { getTemporalClient } from "@repo/temporal";
import {
	MEMORY_WRITE_WORKFLOW_EXECUTION_TIMEOUT_MS,
	MEMORY_WRITE_WORKFLOW_TASK_QUEUE,
	MEMORY_WRITE_WORKFLOW_TYPE,
	type MemoryWriteWorkflowInput,
} from "@repo/temporal/memory-write-types";
import { withCorrelationMemo } from "../../../../lib/temporal-correlation";

/**
 * Starts the workflow for `input.writeId`. An execution that is already open
 * under the derived id means an earlier request started it (a retried
 * submission), which is the outcome wanted, so it is not a failure. Matched by
 * name: `@temporalio/client` is not a dependency of this package. Any other
 * failure is thrown: the caller owns a receipt it must close out.
 */
export async function startMemoryWriteWorkflow(
	input: MemoryWriteWorkflowInput,
): Promise<void> {
	const client = await getTemporalClient();
	try {
		await client.workflow.start(
			MEMORY_WRITE_WORKFLOW_TYPE,
			withCorrelationMemo({
				taskQueue: MEMORY_WRITE_WORKFLOW_TASK_QUEUE,
				workflowId: memoryWriteWorkflowId(input.writeId),
				workflowExecutionTimeout:
					MEMORY_WRITE_WORKFLOW_EXECUTION_TIMEOUT_MS,
				args: [
					{
						writeId: input.writeId,
						projectId: input.projectId,
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
