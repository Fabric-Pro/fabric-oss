import { ORPCError } from "@orpc/client";
import { hasWorkflowAccess, listWorkflowExecutions } from "@repo/database";
import { WorkflowExecutionStatusSchema } from "@repo/database/prisma/zod";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { verifyOrganizationMembership } from "../../../organizations/lib/membership";

export const listWorkflowExecutionsProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.WORKSPACE_READ))
	.route({
		method: "GET",
		path: "/workflows/{id}/executions",
		tags: ["Workflows"],
		summary: "List workflow executions",
		description: "List executions for a workflow",
	})
	.input(
		z.object({
			id: z.string(),
			organizationId: z.string().nullable().optional(),
			status: WorkflowExecutionStatusSchema.optional(),
			limit: z.number().min(1).max(100).optional().default(20),
			offset: z.number().min(0).optional().default(0),
		}),
	)
	.handler(async ({ input, context }) => {
		const user = context.user;
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		// Verify organization membership if in org context
		if (organizationId) {
			const membership = await verifyOrganizationMembership(
				organizationId,
				user.id,
			);

			if (!membership) {
				throw new ORPCError("FORBIDDEN", {
					message: "You are not a member of this organization",
				});
			}
		}

		// Check workflow access
		const hasAccess = await hasWorkflowAccess(
			input.id,
			user.id,
			organizationId,
		);

		if (!hasAccess) {
			throw new ORPCError("NOT_FOUND", {
				message: "Workflow not found",
			});
		}

		// List executions
		const result = await listWorkflowExecutions({
			workflowId: input.id,
			userId: user.id,
			organizationId,
			status: input.status,
			limit: input.limit,
			offset: input.offset,
		});

		return result;
	});
