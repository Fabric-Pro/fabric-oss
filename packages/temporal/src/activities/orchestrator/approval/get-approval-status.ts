/**
 * Approval Status Activity
 *
 * Retrieves the status of an approval request.
 */

import { db } from "@repo/database";

/**
 * Gets the status of an approval request.
 *
 * Used for polling in HITL workflows.
 */
export async function getApprovalStatus(
	approvalId: string,
): Promise<{ status: string; feedback?: string }> {
	const approval = await db.agentApproval.findUnique({
		where: { id: approvalId },
	});

	if (!approval) {
		throw new Error(`Approval not found: ${approvalId}`);
	}

	return {
		status: approval.status,
		feedback: approval.feedback || undefined,
	};
}
