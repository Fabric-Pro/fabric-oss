/**
 * Unpublish Workflow Procedure
 * Reverts a workflow to draft status
 */

import { ORPCError } from "@orpc/client";
import { db, hasWorkflowAccess } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { syncWorkflowSchedule } from "../../lib/sync-workflow-schedule";

const unpublishWorkflowInput = z.object({
	workflowId: z.string(),
});

const unpublishWorkflowOutput = z.object({
	success: z.boolean(),
	message: z.string(),
});

export const unpublishWorkflow = tenantProtectedProcedure
	.use(requirePermission(Permissions.WORKSPACE_UPDATE))
	.route({
		method: "POST",
		path: "/workflows/{workflowId}/unpublish",
		tags: ["Workflows"],
		summary: "Unpublish a workflow",
		description: "Revert a workflow to draft status",
	})
	.input(unpublishWorkflowInput)
	.output(unpublishWorkflowOutput)
	.handler(async ({ input, context }) => {
		const { workflowId } = input;
		const userId = context.user.id;

		// Ownership gate — see the note in `rollback-workflow.ts`. Org
		// membership alone let any colleague stop another member's live
		// workflow, including one they have no read access to.
		if (!(await hasWorkflowAccess(workflowId, userId))) {
			throw new ORPCError("NOT_FOUND", {
				message: "Workflow not found",
			});
		}

		const workflow = await db.workflow.findUnique({
			where: { id: workflowId },
		});

		if (!workflow) {
			throw new ORPCError("NOT_FOUND", {
				message: "Workflow not found",
			});
		}

		// Update workflow status to draft
		await db.workflow.update({
			where: { id: workflowId },
			data: {
				status: "DRAFT",
				// Keep the published version info for reference
			},
		});

		// A draft must not keep firing. Removing the schedule here is what
		// makes "unpublish" mean "stop", rather than leaving a cron running
		// against a workflow the user believes is inactive.
		await syncWorkflowSchedule({
			workflowId,
			nodes: workflow.nodes,
			userId: workflow.userId,
			organizationId: workflow.organizationId,
			projectId: workflow.projectId,
			workflowName: workflow.name,
			active: false,
		});

		return {
			success: true,
			message: "Workflow unpublished and reverted to draft status",
		};
	});
