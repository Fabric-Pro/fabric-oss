import { ORPCError } from "@orpc/client";
import {
	deleteWorkflowIntegration,
	getWorkflowIntegrationById,
	listProjectsBoundToIntegration,
	Prisma,
} from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { verifyOrganizationMembership } from "../../../organizations/lib/membership";

/**
 * Delete integration procedure
 * Removes an integration and its credentials
 */

function bindingConflictMessage(bound: Array<{ projectName: string }>): string {
	const names =
		bound.length > 0
			? bound.map((p) => p.projectName).join(", ")
			: "one or more projects";
	return `This connection is used as project knowledge by: ${names}. Disconnect it from those projects' settings first.`;
}

export const deleteIntegrationProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.WORKSPACE_DELETE))
	.route({
		method: "DELETE",
		path: "/workflows/integrations/{integrationId}",
		tags: ["Workflows", "Integrations"],
		summary: "Delete integration",
		description: "Delete an integration and its credentials",
	})
	.input(
		z.object({
			integrationId: z.string(),
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

		// Check if integration exists and belongs to user
		const integration = await getWorkflowIntegrationById(
			input.integrationId,
			user.id,
			organizationId,
		);

		if (!integration) {
			throw new ORPCError("NOT_FOUND", {
				message: "Integration not found",
			});
		}

		// Fail loudly (naming the dependent projects) instead of surfacing the
		// raw FK error — ProjectDatabricksKnowledgeBinding.integration is
		// `onDelete: Restrict` so a project's knowledge binding can't be
		// silently wiped by deleting the connection out from under it.
		const boundProjects = await listProjectsBoundToIntegration(
			input.integrationId,
		);
		if (boundProjects.length > 0) {
			throw new ORPCError("CONFLICT", {
				message: bindingConflictMessage(boundProjects),
			});
		}

		try {
			await deleteWorkflowIntegration(
				input.integrationId,
				user.id,
				organizationId,
			);
		} catch (error) {
			// Check-then-delete race: a binding created between the check
			// above and the delete is blocked by the RESTRICT FK (P2003).
			// Report it as the same named CONFLICT instead of letting the raw
			// constraint error escape.
			if (
				error instanceof Prisma.PrismaClientKnownRequestError &&
				error.code === "P2003"
			) {
				const nowBound = await listProjectsBoundToIntegration(
					input.integrationId,
				);
				throw new ORPCError("CONFLICT", {
					message: bindingConflictMessage(nowBound),
				});
			}
			throw error;
		}

		return {
			success: true,
			message: "Integration deleted successfully",
		};
	});
