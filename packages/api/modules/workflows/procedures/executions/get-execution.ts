import { ORPCError } from "@orpc/client";
import { getWorkflowExecutionById } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { verifyOrganizationMembership } from "../../../organizations/lib/membership";

export const getWorkflowExecutionProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.WORKSPACE_READ))
	.route({
		method: "GET",
		path: "/workflows/executions/{executionId}",
		tags: ["Workflows"],
		summary: "Get workflow execution",
		description: "Get a workflow execution by ID",
	})
	.input(
		z.object({
			executionId: z.string(),
			organizationId: z.string().nullable().optional(),
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

		// Get execution
		const execution = await getWorkflowExecutionById(
			input.executionId,
			user.id,
			organizationId,
		);

		if (!execution) {
			throw new ORPCError("NOT_FOUND", {
				message: "Execution not found",
			});
		}

		return { execution };
	});
