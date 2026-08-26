/**
 * Respond to Approval Procedure
 *
 * Allows a user to approve or reject a pending approval request.
 * Sends a signal to the Temporal approval workflow.
 */

import { db } from "@repo/database";
import { approveSignal, getTemporalClient } from "@repo/temporal";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";

const inputSchema = z.object({
	approvalId: z.string(),
	approved: z.boolean(),
	feedback: z.string().optional(),
});

const outputSchema = z.object({
	success: z.boolean(),
	message: z.string(),
	approval: z
		.object({
			id: z.string(),
			status: z.string(),
			feedback: z.string().nullable(),
			decidedAt: z.string().nullable(),
		})
		.optional(),
});

export const respondToApproval = tenantProtectedProcedure
	.use(requirePermission(Permissions.WORKSPACE_UPDATE))
	.route({
		method: "POST",
		path: "/workflows/approvals/{approvalId}/respond",
		tags: ["Workflow Approvals"],
		summary: "Respond to approval request",
		description: "Approve or reject a pending approval request",
	})
	.input(inputSchema)
	.output(outputSchema)
	.handler(async ({ input, context }) => {
		const { approvalId, approved, feedback } = input;
		const { user } = context;

		// Find the approval request
		const approval = await db.agentApproval.findUnique({
			where: { id: approvalId },
			include: {
				task: {
					select: {
						id: true,
						workflowId: true,
						runId: true,
					},
				},
			},
		});

		if (!approval) {
			return {
				success: false,
				message: "Approval request not found",
			};
		}

		// Verify the user owns this approval
		if (approval.userId !== user.id) {
			return {
				success: false,
				message:
					"You are not authorized to respond to this approval request",
			};
		}

		// Check if already decided
		if (approval.status !== "pending") {
			return {
				success: false,
				message: `Approval request has already been ${approval.status}`,
			};
		}

		// Try to send signal to Temporal workflow
		try {
			const client = await getTemporalClient();
			const workflowId = `approval-${approvalId}`;

			// Get the workflow handle
			const handle = client.workflow.getHandle(workflowId);

			// Send the approval signal
			await handle.signal(approveSignal, {
				approved,
				feedback,
				decidedBy: user.id,
			});

			console.log(
				`[ApprovalAPI] Signal sent to workflow ${workflowId}:`,
				{
					approved,
					feedback,
				},
			);

			// Update the AgentTask status after successful signal
			const decidedAt = new Date();
			await db.agentTask.update({
				where: { id: approval.taskId },
				data: {
					status: approved ? "completed" : "failed",
					completedAt: decidedAt,
				},
			});

			// Also update the approval record
			await db.agentApproval.update({
				where: { id: approvalId },
				data: {
					status: approved ? "approved" : "rejected",
					feedback,
					decidedAt,
				},
			});
		} catch (error) {
			console.warn(
				"[ApprovalAPI] Could not signal workflow (may have expired):",
				error,
			);

			// If workflow doesn't exist, update the database directly
			// This handles cases where the workflow timed out
			const decidedAt = new Date();

			await db.agentApproval.update({
				where: { id: approvalId },
				data: {
					status: approved ? "approved" : "rejected",
					feedback,
					decidedAt,
				},
			});

			// Also update the linked task
			await db.agentTask.update({
				where: { id: approval.taskId },
				data: {
					status: approved ? "completed" : "failed",
					completedAt: decidedAt,
				},
			});

			return {
				success: true,
				message: `Approval ${approved ? "granted" : "rejected"} (workflow already completed)`,
				approval: {
					id: approvalId,
					status: approved ? "approved" : "rejected",
					feedback: feedback || null,
					decidedAt: decidedAt.toISOString(),
				},
			};
		}

		// Fetch updated approval record
		const updatedApproval = await db.agentApproval.findUnique({
			where: { id: approvalId },
		});

		return {
			success: true,
			message: `Approval ${approved ? "granted" : "rejected"} successfully`,
			approval: updatedApproval
				? {
						id: updatedApproval.id,
						status: updatedApproval.status,
						feedback: updatedApproval.feedback,
						decidedAt:
							updatedApproval.decidedAt?.toISOString() || null,
					}
				: undefined,
		};
	});
