import { ORPCError } from "@orpc/client";
import { createWorkflowVersion, hasWorkflowAccess } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { verifyOrganizationMembership } from "../../../organizations/lib/membership";

export const createWorkflowVersionProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.WORKSPACE_CREATE))
	.route({
		method: "POST",
		path: "/workflows/{id}/versions",
		tags: ["Workflows"],
		summary: "Create workflow version",
		description: "Create a new version snapshot of a workflow",
	})
	.input(
		z.object({
			id: z.string(),
			changelog: z.string().optional(),
			organizationId: z.string().nullable().optional(),
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

		// Create version
		const version = await createWorkflowVersion(
			input.id,
			user.id,
			input.changelog,
			organizationId,
		);

		return { version };
	});
