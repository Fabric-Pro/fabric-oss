import { instructionRepositorySyncWorkflowId } from "@repo/instructions";
import { getTemporalClient } from "@repo/temporal";
import { withCorrelationMemo } from "../../../../../lib/temporal-correlation";

/**
 * Starts the project's repository sync (design 2026-09-23 §5.2). ONE id per
 * project and `workflowIdConflictPolicy: "FAIL"`, so a second start while a
 * run is open is refused by Temporal itself: `false` means already running.
 * The reuse policy stays the default, so a finished run never blocks the
 * next.
 */
export async function startInstructionRepositorySync(input: {
	projectId: string;
	organizationId: string;
	trigger: "MANUAL";
	requesterUserId: string;
}): Promise<boolean> {
	const client = await getTemporalClient();
	try {
		await client.workflow.start(
			"projectInstructionRepositorySyncWorkflow",
			withCorrelationMemo({
				// The workflow and its child snapshot workflow share the
				// instructions queue; the sync's own activities route
				// themselves to the general queue inside the workflow.
				taskQueue: "project-instructions",
				workflowId: instructionRepositorySyncWorkflowId(
					input.projectId,
				),
				workflowIdConflictPolicy: "FAIL",
				args: [input],
			}),
		);
		return true;
	} catch (error) {
		if (
			error instanceof Error &&
			error.name === "WorkflowExecutionAlreadyStartedError"
		) {
			return false;
		}
		throw error;
	}
}

/** Whether a sync run is open. Any failure to ask reads as "not running": the tab degrades to "Sync now". */
export async function isInstructionRepositorySyncRunning(
	projectId: string,
): Promise<boolean> {
	try {
		const client = await getTemporalClient();
		const description = await client.workflow
			.getHandle(instructionRepositorySyncWorkflowId(projectId))
			.describe();
		return description.status.name === "RUNNING";
	} catch {
		return false;
	}
}
