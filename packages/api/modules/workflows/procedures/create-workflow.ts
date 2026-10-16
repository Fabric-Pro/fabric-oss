import { WorkflowTriggerTypeSchema } from "@repo/database/prisma/zod";
import { z } from "zod";
import { INPUT_BOUNDS } from "../../..//lib/zod-bounds";
import {
	Permissions,
	requireInputOrgPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import { createWorkflowCommand } from "../lib/workflow-commands";
import { workflowActor, workflowCommandErrors } from "./workflow-actor";

// JSON-compatible schema for workflow data
const JsonValueSchema = z.any();

export const createWorkflowProcedure = tenantProtectedProcedure
	.use(workflowCommandErrors)
	.use(
		requireInputOrgPermission(Permissions.WORKSPACE_CREATE, {
			requireOrganization: true,
		}),
	)
	.route({
		method: "POST",
		path: "/workflows",
		tags: ["Workflows"],
		summary: "Create workflow",
		description: "Create a new workflow",
	})
	.input(
		z.object({
			name: z.string().min(1).max(255),
			description: z.string().max(INPUT_BOUNDS.description).optional(),
			triggerType: WorkflowTriggerTypeSchema.optional().default("MANUAL"),
			triggerConfig: JsonValueSchema.optional(),
			nodes: z.array(JsonValueSchema).optional(),
			edges: z.array(JsonValueSchema).optional(),
			variables: JsonValueSchema.optional(),
			settings: JsonValueSchema.optional(),
			isTemplate: z.boolean().optional().default(false),
			templateId: z.string().optional(),
			organizationId: z.string().nullable().optional(),
			projectId: z.string().optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);
		const { organizationId: _inputOrgId, ...fields } = input;
		const workflow = await createWorkflowCommand(
			workflowActor(context.user.id, organizationId),
			fields,
		);
		return { workflow };
	});
