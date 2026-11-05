import { rollbackWorkflowCommand } from "../../lib/workflow-lifecycle-commands";
/**
 * Rollback Workflow Procedure
 * Rolls back a workflow to a previous published version
 */

import { z } from "zod";
import {
	Permissions,
	requireInputOrgPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { workflowActor, workflowCommandErrors } from "../workflow-actor";

const rollbackWorkflowInput = z.object({
	workflowId: z.string(),
	organizationId: z.string().nullable().optional(),
	targetVersion: z.number().int().positive(),
});

const rollbackWorkflowOutput = z.object({
	success: z.boolean(),
	version: z.number(),
	message: z.string(),
});

export const rollbackWorkflow = tenantProtectedProcedure
	.use(workflowCommandErrors)
	.use(
		requireInputOrgPermission(Permissions.WORKSPACE_UPDATE, {
			requireOrganization: true,
		}),
	)
	.route({
		method: "POST",
		path: "/workflows/{workflowId}/rollback",
		tags: ["Workflows"],
		summary: "Rollback a workflow",
		description: "Roll back a workflow to a previous published version",
	})
	.input(rollbackWorkflowInput)
	.output(rollbackWorkflowOutput)
	.handler(async ({ input, context }) =>
		rollbackWorkflowCommand(
			workflowActor(
				context.user.id,
				resolveOrganizationId(input.organizationId, context.session),
			),
			{
				workflowId: input.workflowId,
				targetVersion: input.targetVersion,
			},
		),
	);
