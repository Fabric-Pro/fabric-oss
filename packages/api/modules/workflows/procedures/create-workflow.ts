import { ORPCError } from "@orpc/client";
import { createWorkflow, type Prisma } from "@repo/database";
import { WorkflowTriggerTypeSchema } from "@repo/database/prisma/zod";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import { verifyOrganizationMembership } from "../../organizations/lib/membership";

// JSON-compatible schema for workflow data
const JsonValueSchema = z.any();

export const createWorkflowProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.WORKSPACE_CREATE))
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
			description: z.string().optional(),
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
		const user = context.user;
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		// Verify organization membership if in org context
		if (organizationId) {
			const membership = await verifyOrganizationMembership(
				organizationId,
				user.id,
			);

			if (!membership) {
				throw new ORPCError("FORBIDDEN", {
					message: "You are not a member of this organization",
				});
			}
		}

		// Create workflow
		const workflow = await createWorkflow({
			name: input.name,
			description: input.description,
			triggerType: input.triggerType,
			triggerConfig: input.triggerConfig as
				| Prisma.InputJsonValue
				| undefined,
			nodes: input.nodes as Prisma.InputJsonValue | undefined,
			edges: input.edges as Prisma.InputJsonValue | undefined,
			variables: input.variables as Prisma.InputJsonValue | undefined,
			settings: input.settings as Prisma.InputJsonValue | undefined,
			isTemplate: input.isTemplate,
			templateId: input.templateId,
			userId: user.id,
			organizationId,
			projectId: input.projectId,
		});

		if (!workflow) {
			throw new ORPCError("INTERNAL_SERVER_ERROR", {
				message: "Failed to create workflow",
			});
		}

		return { workflow };
	});
