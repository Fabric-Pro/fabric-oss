/**
 * Activity backing the scheduled kickoff workflow.
 *
 * A Temporal Schedule fires with fixed arguments, so it cannot carry a
 * per-fire execution id — every tick needs its own `WorkflowExecution` row, or
 * runs would overwrite each other's status and logs. The kickoff workflow
 * creates that row here and then runs the graph against it.
 */

import {
	createWorkflowExecution,
	getWorkflowById,
	type Prisma,
} from "@repo/database";

export interface CreateScheduledExecutionInput {
	workflowId: string;
	userId: string;
	organizationId?: string;
}

export interface CreateScheduledExecutionResult {
	executionId: string;
	version: number;
	projectId?: string;
	/** False when the workflow is gone or no longer published. */
	shouldRun: boolean;
	reason?: string;
}

export async function createScheduledExecution(
	input: CreateScheduledExecutionInput,
): Promise<CreateScheduledExecutionResult> {
	const workflow = await getWorkflowById(
		input.workflowId,
		input.userId,
		input.organizationId,
	);

	if (!workflow) {
		// The workflow was deleted but its schedule outlived it. Reconciliation
		// removes these; until then, skip quietly rather than failing a run
		// nobody can see.
		return {
			executionId: "",
			version: 0,
			shouldRun: false,
			reason: "Workflow no longer exists",
		};
	}

	// Only a published workflow runs on a schedule. Unpublishing deletes the
	// schedule, so this is the belt-and-braces case where that did not land.
	if (workflow.status !== "PUBLISHED" && workflow.status !== "ACTIVE") {
		return {
			executionId: "",
			version: workflow.version,
			shouldRun: false,
			reason: `Workflow is ${workflow.status}, not published`,
		};
	}

	const execution = await createWorkflowExecution({
		workflowId: input.workflowId,
		version: workflow.version,
		triggerType: "SCHEDULE",
		triggerInput: {
			source: "schedule",
		} as Prisma.InputJsonValue,
		userId: input.userId,
		organizationId: input.organizationId,
	});

	return {
		executionId: execution.id,
		version: workflow.version,
		projectId: workflow.projectId ?? undefined,
		shouldRun: true,
	};
}
