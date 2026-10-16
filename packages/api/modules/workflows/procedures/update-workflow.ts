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
import { updateWorkflowCommand } from "../lib/workflow-commands";
import { workflowActor, workflowCommandErrors } from "./workflow-actor";

// JSON-compatible schema for workflow data
const JsonValueSchema = z.any();

export const updateWorkflowProcedure = tenantProtectedProcedure
	.use(workflowCommandErrors)
	.use(
		requireInputOrgPermission(Permissions.WORKSPACE_UPDATE, {
			requireOrganization: true,
		}),
	)
	.route({
		method: "PATCH",
		path: "/workflows/{id}",
		tags: ["Workflows"],
		summary: "Update workflow",
		description: "Update a workflow",
	})
	.input(
		z.object({
			id: z.string(),
			organizationId: z.string().nullable().optional(),
			name: z.string().min(1).max(255).optional(),
			description: z.string().max(INPUT_BOUNDS.description).optional(),
			status: WorkflowBuilderStatusSchema.optional(),
			triggerType: WorkflowTriggerTypeSchema.optional(),
			triggerConfig: JsonValueSchema.optional(),
			nodes: z.array(JsonValueSchema).optional(),
			edges: z.array(JsonValueSchema).optional(),
			variables: JsonValueSchema.optional(),
			settings: JsonValueSchema.optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);
		const { organizationId: _inputOrgId, ...fields } = input;
		const workflow = await updateWorkflowCommand(
			workflowActor(context.user.id, organizationId),
			fields,
		);
		return { workflow };
	});
