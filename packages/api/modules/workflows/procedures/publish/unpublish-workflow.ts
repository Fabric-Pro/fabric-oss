/**
 * Unpublish Workflow Procedure
 * Reverts a workflow to draft status
 */

import { z } from "zod";
import {
	Permissions,
	requirePermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { unpublishWorkflowCommand } from "../../lib/workflow-commands";
import { workflowActor, workflowCommandErrors } from "../workflow-actor";

const unpublishWorkflowInput = z.object({
	workflowId: z.string(),
});

const unpublishWorkflowOutput = z.object({
	success: z.boolean(),
	message: z.string(),
});

export const unpublishWorkflow = tenantProtectedProcedure
	.use(workflowCommandErrors)
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
	.handler(async ({ input, context }) =>
		unpublishWorkflowCommand(
			workflowActor(
				context.user.id,
				resolveOrganizationId(undefined, context.session),
			),
			input.workflowId,
		),
	);
