/**
 * Execution Progress Activity
 *
 * Updates execution progress for real-time tracking.
 */

import { db } from "@repo/database";
import type { UpdateExecutionProgressInput } from "../types";

/**
 * Updates execution progress in the database.
 *
 * Features:
 * - Updates task phase and state
 * - Provides real-time progress info
 */
export async function updateExecutionProgress(
	input: UpdateExecutionProgressInput,
): Promise<void> {
	console.log("[Orchestrator] Updating execution progress", input);

	// Update task record with progress
	await db.agentTask.updateMany({
		where: { workflowId: input.executionId },
		data: {
			stage: input.phase,
			state: JSON.parse(
				JSON.stringify({
					phase: input.phase,
					message: input.message,
					currentStep: input.currentStep,
					completedSteps: input.completedSteps,
					totalSteps: input.totalSteps,
					updatedAt: new Date().toISOString(),
				}),
			),
		},
	});
}

/**
 * Updates an approval task's status after approval decision.
 *
 * This should be called when an approval is granted or rejected
 * to update the AgentTask record created by createOrchestratorApprovalRequest.
 */
export async function updateApprovalTaskStatus(input: {
	approvalId: string;
	approved: boolean;
	feedback?: string;
}): Promise<void> {
	console.log("[Orchestrator] Updating approval task status", {
		approvalId: input.approvalId,
		approved: input.approved,
	});

	// Find the approval record to get the task ID
	const approval = await db.agentApproval.findUnique({
		where: { id: input.approvalId },
		select: { taskId: true },
	});

	if (!approval) {
		console.warn(
			"[Orchestrator] Approval not found for status update:",
			input.approvalId,
		);
		return;
	}

	// Update the AgentTask status
	await db.agentTask.update({
		where: { id: approval.taskId },
		data: {
			status: input.approved ? "completed" : "failed",
			completedAt: new Date(),
			result: {
				approved: input.approved,
				feedback: input.feedback,
				decidedAt: new Date().toISOString(),
			},
		},
	});

	// Also update the approval record
	await db.agentApproval.update({
		where: { id: input.approvalId },
		data: {
			status: input.approved ? "approved" : "rejected",
			feedback: input.feedback,
			decidedAt: new Date(),
		},
	});

	console.log(
		"[Orchestrator] Approval task status updated:",
		input.approved ? "completed" : "failed",
	);
}
