import { ORPCError } from "@orpc/client";
import { listWorkflows } from "@repo/database";
import {
	WorkflowBuilderStatusSchema,
	WorkflowTriggerTypeSchema,
} from "@repo/database/prisma/zod";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import { verifyOrganizationMembership } from "../../organizations/lib/membership";

export const listWorkflowsProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.WORKSPACE_READ))
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
			search: z.string().optional(),
			isTemplate: z.boolean().optional(),
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

		// List workflows
		const result = await listWorkflows({
			userId: user.id,
			organizationId,
			limit: input.limit,
			offset: input.offset,
			status: input.status,
			triggerType: input.triggerType,
			search: input.search,
			isTemplate: input.isTemplate,
			projectId: input.projectId,
		});

		return result;
	});
