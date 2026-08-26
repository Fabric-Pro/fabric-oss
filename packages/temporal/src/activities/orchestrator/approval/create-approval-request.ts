/**
 * Approval Request Activity
 *
 * Creates human-in-the-loop approval requests for high-risk operations.
 */

import { db, type Prisma } from "@repo/database";
import type { CreateApprovalRequestInput } from "../types";

/**
 * Creates an approval request for a step requiring human authorization.
 *
 * Features:
 * - Creates task record for the approval
 * - Creates approval record with risk assessment
 * - Returns approval ID for polling
 */
export async function createOrchestratorApprovalRequest(
	input: CreateApprovalRequestInput,
): Promise<{ approvalId: string }> {
	console.log("[Orchestrator] Creating approval request");

	// Create task for the approval
	const task = await db.agentTask.create({
		data: {
			userId: input.userId,
			organizationId: input.organizationId,
			agentId: "orchestrator",
			status: "pending",
			stage: "approval",
			input: {
				executionId: input.executionId,
				stepId: input.stepId,
				stepDescription: input.stepDescription,
				stepType: input.stepType,
				riskScore: input.riskScore,
				riskLevel: input.riskLevel,
				riskFactors: input.riskFactors,
			},
			framework: "temporal",
			workflowId: input.executionId,
		},
	});

	// Create approval record with affected items for per-item approval UI
	// Build the changes object as JSON-compatible structure
	const changesData: Record<string, unknown> = {
		stepId: input.stepId,
		stepDescription: input.stepDescription,
		stepType: input.stepType,
		riskScore: input.riskScore,
		riskLevel: input.riskLevel,
		riskFactors: input.riskFactors,
	};

	// Include affected items for bulk destructive operations
	// This enables the UI to show per-item approval cards
	if (input.affectedItems && input.affectedItems.length > 0) {
		changesData.affectedItems = input.affectedItems.map((item) => ({
			id: item.id,
			name: item.name,
			type: item.type,
			...(item.metadata ? { metadata: item.metadata } : {}),
		}));
		changesData.affectedItemCount = input.affectedItems.length;
	}

	const approval = await db.agentApproval.create({
		data: {
			taskId: task.id,
			userId: input.userId,
			status: "pending",
			changes: changesData as Prisma.InputJsonValue,
			confidence: input.riskScore ? 1 - input.riskScore / 100 : undefined,
			weaveExecutionId: input.weaveExecutionId,
			weavePlanId: input.weavePlanId,
			weaveContext: input.weaveContext as
				| Prisma.InputJsonValue
				| undefined,
		},
	});

	return { approvalId: approval.id };
}
