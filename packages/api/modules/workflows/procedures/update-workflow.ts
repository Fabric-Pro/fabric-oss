import { ORPCError } from "@orpc/client";
import { hasWorkflowAccess, type Prisma, updateWorkflow } from "@repo/database";
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
import { syncWorkflowSchedule } from "../lib/sync-workflow-schedule";

// JSON-compatible schema for workflow data
const JsonValueSchema = z.any();

export const updateWorkflowProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.WORKSPACE_UPDATE))
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
			description: z.string().optional(),
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

		// Check workflow access
		const hasAccess = await hasWorkflowAccess(
			input.id,
			user.id,
			organizationId,
		);

		if (!hasAccess) {
			throw new ORPCError("NOT_FOUND", {
				message: "Workflow not found",
			});
		}

		// Update workflow - cast JSON fields to Prisma types
		const { id, organizationId: _inputOrgId, ...rest } = input;
		const updateData = {
			...rest,
			triggerConfig: rest.triggerConfig as
				| Prisma.InputJsonValue
				| undefined,
			nodes: rest.nodes as Prisma.InputJsonValue | undefined,
			edges: rest.edges as Prisma.InputJsonValue | undefined,
			variables: rest.variables as Prisma.InputJsonValue | undefined,
			settings: rest.settings as Prisma.InputJsonValue | undefined,
		};
		const workflow = await updateWorkflow(
			id,
			user.id,
			updateData,
			organizationId,
		);

		// Editing a PUBLISHED workflow's trigger must take effect immediately:
		// changing the cron, or switching the trigger away from Schedule,
		// should not require an unpublish/republish cycle.
		//
		// A status change has to sync too, and in both directions. Pausing a
		// workflow used to leave its schedule running — this branch only fired
		// for PUBLISHED/ACTIVE, so moving to PAUSED simply skipped it and the
		// cron kept firing against a workflow the author believed was stopped.
		// Autosave is the reason this is not unconditional: a draft save posts
		// no status, and reaching for Temporal on every keystroke would be a
		// round trip for nothing.
		const scheduleShouldBeLive =
			workflow.status === "PUBLISHED" || workflow.status === "ACTIVE";

		if (scheduleShouldBeLive || input.status !== undefined) {
			await syncWorkflowSchedule({
				workflowId: id,
				nodes: workflow.nodes,
				userId: workflow.userId,
				organizationId: workflow.organizationId,
				projectId: workflow.projectId,
				workflowName: workflow.name,
				active: scheduleShouldBeLive,
			});
		}

		return { workflow };
	});
