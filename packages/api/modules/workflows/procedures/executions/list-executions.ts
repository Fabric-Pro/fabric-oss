import { WorkflowExecutionStatusSchema } from "@repo/database/prisma/zod";
import { z } from "zod";
import {
	Permissions,
	requireInputOrgPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { listWorkflowExecutionsCommand } from "../../lib/workflow-execution-commands";
import { workflowActor, workflowCommandErrors } from "../workflow-actor";

export const listWorkflowExecutionsProcedure = tenantProtectedProcedure
	.use(workflowCommandErrors)
	.use(
		requireInputOrgPermission(Permissions.WORKSPACE_READ, {
			requireOrganization: true,
		}),
	)
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
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);
		return listWorkflowExecutionsCommand(
			workflowActor(context.user.id, organizationId),
			{
				workflowId: input.id,
				status: input.status,
				limit: input.limit,
				offset: input.offset,
			},
		);
	});
