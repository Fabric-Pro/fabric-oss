import {
	WorkflowBuilderStatusSchema,
	WorkflowTriggerTypeSchema,
} from "@repo/database/prisma/zod";
import { z } from "zod";
import { INPUT_BOUNDS } from "../../..//lib/zod-bounds";
import {
	Permissions,
	requireInputOrgPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import { listWorkflowsCommand } from "../lib/workflow-read-commands";
import { workflowActor, workflowCommandErrors } from "./workflow-actor";

export const listWorkflowsProcedure = tenantProtectedProcedure
	.use(workflowCommandErrors)
	.use(
		requireInputOrgPermission(Permissions.WORKSPACE_READ, {
			requireOrganization: true,
		}),
	)
	.route({
		method: "GET",
		path: "/workflows",
		tags: ["Workflows"],
		summary: "List workflows",
		description: "List workflows for the authenticated user",
	})
	.input(
		z.object({
			organizationId: z.string().nullable().optional(),
			limit: z.number().min(1).max(100).optional().default(20),
			offset: z.number().min(0).optional().default(0),
			status: WorkflowBuilderStatusSchema.optional(),
			triggerType: WorkflowTriggerTypeSchema.optional(),
			search: z.string().max(INPUT_BOUNDS.name).optional(),
			isTemplate: z.boolean().optional(),
			projectId: z.string().optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);
		const { organizationId: _inputOrgId, ...filters } = input;
		return listWorkflowsCommand(
			workflowActor(context.user.id, organizationId),
			filters,
		);
	});
