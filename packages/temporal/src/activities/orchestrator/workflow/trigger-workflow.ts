/**
 * Workflow Trigger Activity
 *
 * Triggers pre-defined workflows from the orchestrator.
 */

import { db } from "@repo/database";
import type { TriggerWorkflowInput } from "../types";

/**
 * Triggers a workflow execution.
 *
 * Features:
 * - Validates workflow exists and is manually triggerable
 * - Creates execution record
 * - Returns execution ID for tracking
 */
export async function triggerWorkflow(
	input: TriggerWorkflowInput,
): Promise<{ executionId: string; status: string }> {
	console.log(`[Orchestrator] Triggering workflow: ${input.workflowId}`);

	const workflow = await db.workflow.findUnique({
		where: { id: input.workflowId },
	});

	if (!workflow) {
		throw new Error(`Workflow not found: ${input.workflowId}`);
	}

	if (workflow.triggerType !== "MANUAL") {
		throw new Error(
			`Workflow ${workflow.name} is not manually triggerable`,
		);
	}

	// Create execution record
	const execution = await db.workflowExecution.create({
		data: {
			workflowId: workflow.id,
			version: workflow.version,
			userId: input.userId,
			organizationId: input.organizationId,
			status: "PENDING",
			triggerType: "MANUAL",
			triggerInput: input.variables
				? JSON.parse(JSON.stringify(input.variables))
				: {},
		},
	});

	// The actual execution would be handled by the workflow executor
	// This just creates the execution record

	return {
		executionId: execution.id,
		status: "PENDING",
	};
}
