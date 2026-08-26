/**
 * List Pending Approvals Procedure
 *
 * Returns all pending approval requests for the current user.
 */

import { db } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";

const inputSchema = z.object({
	limit: z.number().min(1).max(100).default(20),
	offset: z.number().min(0).default(0),
	organizationId: z.string().nullable().optional(),
});

// Schema for affected items in bulk operations
const affectedItemSchema = z.object({
	id: z.string(),
	name: z.string(),
	type: z.string(),
	metadata: z.record(z.string(), z.unknown()).optional(),
});

const pendingApprovalSchema = z.object({
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
	createdAt: z.string(),
	expiresAt: z.string().nullable(),
	// Per-item approval for bulk destructive operations
	affectedItems: z.array(affectedItemSchema).optional(),
	affectedItemCount: z.number().optional(),
});

const outputSchema = z.object({
	approvals: z.array(pendingApprovalSchema),
	total: z.number(),
	hasMore: z.boolean(),
});

export const listPendingApprovals = tenantProtectedProcedure
	.use(requirePermission(Permissions.WORKSPACE_READ))
	.route({
		method: "GET",
		path: "/workflows/approvals",
		tags: ["Workflow Approvals"],
		summary: "List pending approvals",
		description: "List all pending approval requests for the current user",
	})
	.input(inputSchema)
	.output(outputSchema)
	.handler(async ({ input, context }) => {
		const { limit, offset, organizationId } = input;
		const { user } = context;

		try {
			// Query pending approvals for the user
			const [approvals, total] = await Promise.all([
				db.agentApproval.findMany({
					where: {
						userId: user.id,
						status: "pending",
					},
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
					orderBy: { createdAt: "desc" },
					skip: offset,
					take: limit,
				}),
				db.agentApproval.count({
					where: {
						userId: user.id,
						status: "pending",
					},
				}),
			]);

			// Transform to output format
			const transformedApprovals = approvals
				.filter((a) => {
					// Filter by organization if specified
					if (
						organizationId &&
						a.task?.organizationId !== organizationId
					) {
						return false;
					}
					return true;
				})
				.map((approval) => {
					const changes = approval.changes as Record<
						string,
						unknown
					> | null;

					// Extract affected items for per-item approval UI
					const rawAffectedItems = changes?.affectedItems;
					const affectedItems = Array.isArray(rawAffectedItems)
						? (rawAffectedItems as Array<{
								id: string;
								name: string;
								type: string;
								metadata?: Record<string, unknown>;
							}>)
						: undefined;

					return {
						id: approval.id,
						taskId: approval.taskId,
						status: approval.status,
						stepId: (changes?.stepId as string) || null,
						stepType: (changes?.stepType as string) || null,
						stepDescription:
							(changes?.stepDescription as string) ||
							"Unknown step",
						riskScore: (changes?.riskScore as number) ?? null,
						riskLevel: (changes?.riskLevel as string) ?? null,
						riskFactors: (changes?.riskFactors as string[]) || [],
						executionId: (changes?.executionId as string) || null,
						workflowId: (changes?.workflowId as string) || null,
						createdAt: approval.createdAt.toISOString(),
						expiresAt:
							(
								approval as { expiresAt?: Date }
							).expiresAt?.toISOString() || null,
						// Include affected items for bulk operations
						affectedItems,
						affectedItemCount:
							(changes?.affectedItemCount as number) ??
							affectedItems?.length,
					};
				});

			return {
				approvals: transformedApprovals,
				total,
				hasMore: offset + limit < total,
			};
		} catch (error) {
			// Log error but return empty result to avoid breaking the UI
			console.error(
				"[listPendingApprovals] Error fetching approvals:",
				error,
			);
			return {
				approvals: [],
				total: 0,
				hasMore: false,
			};
		}
	});
