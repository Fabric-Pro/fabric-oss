import { z } from "zod";
import {
	Permissions,
	requireInputOrgPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { listWorkflowVersionsCommand } from "../../lib/workflow-lifecycle-commands";
import { workflowActor, workflowCommandErrors } from "../workflow-actor";

export const listWorkflowVersionsProcedure = tenantProtectedProcedure
	.use(workflowCommandErrors)
	.use(
		requireInputOrgPermission(Permissions.WORKSPACE_READ, {
			requireOrganization: true,
		}),
	)
	.route({
		method: "GET",
		path: "/workflows/{id}/versions",
		tags: ["Workflows"],
		summary: "List workflow versions",
		description: "List version history for a workflow",
	})
	.input(
		z.object({
			id: z.string(),
			organizationId: z.string().nullable().optional(),
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

		return listWorkflowVersionsCommand(
			workflowActor(user.id, organizationId),
			{ workflowId: input.id, limit: input.limit, offset: input.offset },
		);
	});
