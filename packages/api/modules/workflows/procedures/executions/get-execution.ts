import { z } from "zod";
import {
	Permissions,
	requireInputOrgPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { getWorkflowExecutionCommand } from "../../lib/workflow-read-commands";
import { workflowActor, workflowCommandErrors } from "../workflow-actor";

export const getWorkflowExecutionProcedure = tenantProtectedProcedure
	.use(workflowCommandErrors)
	.use(
		requireInputOrgPermission(Permissions.WORKSPACE_READ, {
			requireOrganization: true,
		}),
	)
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
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);
		const execution = await getWorkflowExecutionCommand(
			workflowActor(context.user.id, organizationId),
			input.executionId,
		);
		return { execution };
	});
