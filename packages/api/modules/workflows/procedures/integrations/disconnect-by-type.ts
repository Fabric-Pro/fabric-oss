import { ORPCError } from "@orpc/client";
import {
	db,
	deleteWorkflowIntegrationByType,
	listProjectsBoundToIntegration,
	Prisma,
	WorkflowIntegrationProviderSchema,
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
 * Disconnect integration by type
 * Removes an integration by its type (e.g., NOTION, LINEAR)
 */
export const disconnectByTypeProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.WORKSPACE_DELETE))
	.route({
		method: "DELETE",
		path: "/workflows/integrations/disconnect/{type}",
		tags: ["Workflows", "Integrations"],
		summary: "Disconnect integration by type",
		description: "Remove an integration by its type",
	})
	.input(
		z.object({
			type: WorkflowIntegrationProviderSchema,
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

		// Fail loudly (naming the dependent projects) instead of surfacing the
		// raw FK error — project Databricks knowledge bindings reference the
		// integration with `onDelete: Restrict`.
		const listBoundForType = async () => {
			const rows = await db.workflowIntegration.findMany({
				where: {
					provider: input.type,
					userId: user.id,
					...(organizationId
						? { organizationId }
						: { organizationId: null }),
				},
				select: { id: true },
			});
			return (
				await Promise.all(
					rows.map((row) => listProjectsBoundToIntegration(row.id)),
				)
			).flat();
		};
		const conflictMessage = (bound: Array<{ projectName: string }>) => {
			const names =
				bound.length > 0
					? bound.map((p) => p.projectName).join(", ")
					: "one or more projects";
			return `This connection is used as project knowledge by: ${names}. Disconnect it from those projects' settings first.`;
		};
		if (input.type === "DATABRICKS_VECTOR_SEARCH") {
			const bound = await listBoundForType();
			if (bound.length > 0) {
				throw new ORPCError("CONFLICT", {
					message: conflictMessage(bound),
				});
			}
		}

		let deleted: boolean;
		try {
			deleted = await deleteWorkflowIntegrationByType(
				input.type,
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
				throw new ORPCError("CONFLICT", {
					message: conflictMessage(await listBoundForType()),
				});
			}
			throw error;
		}

		if (!deleted) {
			throw new ORPCError("NOT_FOUND", {
				message: "Integration not found",
			});
		}

		return {
			success: true,
			message: `${input.type} integration disconnected`,
		};
	});
