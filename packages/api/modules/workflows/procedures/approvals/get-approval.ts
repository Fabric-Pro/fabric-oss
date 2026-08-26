/**
 * Get Approval Procedure
 *
 * Returns details of a specific approval request.
 */

import { db } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";

const inputSchema = z.object({
	approvalId: z.string(),
});

const outputSchema = z.object({
	approval: z
		.object({
			id: z.string(),
			taskId: z.string(),
			status: z.string(),
			stepId: z.string().nullable(),
			stepType: z.string().nullable(),
			stepDescription: z.string(),
			riskScore: z.number().nullable(),
			riskLevel: z.string().nullable(),
			riskFactors: z.array(z.string()),
			executionId: z.string().nullable(),
			workflowId: z.string().nullable(),
			workflowName: z.string().nullable(),
			feedback: z.string().nullable(),
			createdAt: z.string(),
			decidedAt: z.string().nullable(),
			expiresAt: z.string().nullable(),
		})
		.nullable(),
});

export const getApproval = tenantProtectedProcedure
	.use(requirePermission(Permissions.WORKSPACE_READ))
	.route({
		method: "GET",
		path: "/workflows/approvals/{approvalId}",
		tags: ["Workflow Approvals"],
		summary: "Get approval request",
		description: "Get details of a specific approval request",
	})
	.input(inputSchema)
	.output(outputSchema)
	.handler(async ({ input, context }) => {
		const { approvalId } = input;
		const { user } = context;

		const approval = await db.agentApproval.findUnique({
			where: { id: approvalId },
			include: {
				task: {
					select: {
						id: true,
						agentId: true,
						status: true,
						organizationId: true,
					},
				},
			},
		});

		// Not found or not owned by user
		if (!approval || approval.userId !== user.id) {
			return { approval: null };
		}

		const changes = approval.changes as Record<string, unknown> | null;

		return {
			approval: {
				id: approval.id,
				taskId: approval.taskId,
				status: approval.status,
				stepId: (changes?.stepId as string) || null,
				stepType: (changes?.stepType as string) || null,
				stepDescription:
					(changes?.stepDescription as string) || "Unknown step",
				riskScore: (changes?.riskScore as number) ?? null,
				riskLevel: (changes?.riskLevel as string) ?? null,
				riskFactors: (changes?.riskFactors as string[]) || [],
				executionId: (changes?.executionId as string) || null,
				workflowId: (changes?.workflowId as string) || null,
				workflowName: (changes?.workflowName as string) || null,
				feedback: approval.feedback,
				createdAt: approval.createdAt.toISOString(),
				decidedAt: approval.decidedAt?.toISOString() || null,
				expiresAt: approval.expiresAt?.toISOString() || null,
			},
		};
	});
