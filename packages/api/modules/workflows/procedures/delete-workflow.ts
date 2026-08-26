import { ORPCError } from "@orpc/client";
import { deleteWorkflow, hasWorkflowAccess } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import { verifyOrganizationMembership } from "../../organizations/lib/membership";
import { syncWorkflowSchedule } from "../lib/sync-workflow-schedule";

export const deleteWorkflowProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.WORKSPACE_DELETE))
	.route({
		method: "DELETE",
		path: "/workflows/{id}",
		tags: ["Workflows"],
		summary: "Delete workflow",
		description: "Delete a workflow",
	})
	.input(
		z.object({
			id: z.string(),
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

		// Delete workflow
		// Remove the schedule before the workflow row goes, or the cron
		// outlives what it triggers and fires against a workflow that no
		// longer exists.
		await syncWorkflowSchedule({
			workflowId: input.id,
			nodes: [],
			userId: user.id,
			organizationId,
			active: false,
		});

		await deleteWorkflow(input.id, user.id, organizationId);

		return { success: true };
	});
