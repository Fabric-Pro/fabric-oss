import { z } from "zod";
import {
	Permissions,
	requireInputOrgPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import { getWorkflowCommand } from "../lib/workflow-read-commands";
import { workflowActor, workflowCommandErrors } from "./workflow-actor";

export const getWorkflowProcedure = tenantProtectedProcedure
	.use(workflowCommandErrors)
	.use(
		requireInputOrgPermission(Permissions.WORKSPACE_READ, {
			requireOrganization: true,
		}),
	)
	.route({
		method: "GET",
		path: "/workflows/{id}",
		tags: ["Workflows"],
		summary: "Get workflow",
		description: "Get a workflow by ID",
	})
	.input(
		z.object({
			id: z.string(),
			organizationId: z.string().nullable().optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);
		const workflow = await getWorkflowCommand(
			workflowActor(context.user.id, organizationId),
			input.id,
		);
		return { workflow };
	});
