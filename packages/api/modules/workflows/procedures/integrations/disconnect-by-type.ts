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
	authorizeInputOrganization,
	Permissions,
	requirePermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { disconnectPersonalGitLab } from "../../../integrations/lib/gitlab-personal-disconnect";
import { authorizeGitLabTenant } from "../../../integrations/lib/gitlab-request-tenant";
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

		if (input.type === "GITLAB") {
			// The personal GitLab connection goes through the one personal
			// GitLab disconnect (lifecycle lock, generation bump, revocation,
			// MCP token columns emptied, audit). Deleting the row instead would
			// skip the revocation, the audit row and the generation fence on an
			// in-flight refresh.
			// Project repository links are untouched.
			// Resolved and authorized against the organization the input
			// names; a request with no organization is refused rather than
			// disconnecting into a no-organization tenant. Both writes below
			// use this tenant, so they act where the check ran.
			const tenant = await authorizeGitLabTenant(
				Permissions.MCP_CONNECT,
				input.organizationId,
				context,
			);
			// Workflow-scoped GitLab credentials are not the personal
			// connection; deleting them is this procedure's own
			// WORKSPACE_DELETE, and the procedure's permission middleware
			// evaluates that in the SESSION's organization only. Check it in
			// the target organization too — before anything is written, so
			// a refusal leaves both the connection and the rows as they were
			// — and delete exactly the rows that were checked. With none to
			// delete, the personal disconnect stays on MCP_CONNECT alone.
			const scopedRows = await db.workflowIntegration.findMany({
				where: {
					provider: "GITLAB",
					userId: user.id,
					organizationId: tenant.organizationId,
					workflowId: { not: null },
				},
				select: { id: true },
			});
			if (scopedRows.length > 0) {
				await authorizeInputOrganization(
					Permissions.WORKSPACE_DELETE,
					tenant.organizationId,
					context,
					{ requireOrganization: true },
				);
			}
			const personal = await disconnectPersonalGitLab({
				tenant,
				surface: "workflows.integrations.disconnectByType",
				audit: context,
			});
			const scoped =
				scopedRows.length > 0
					? await db.workflowIntegration.deleteMany({
							where: {
								id: { in: scopedRows.map((row) => row.id) },
								userId: user.id,
								organizationId: tenant.organizationId,
							},
						})
					: { count: 0 };
			if (personal.integrationIds.length === 0 && scoped.count === 0) {
				throw new ORPCError("NOT_FOUND", {
					message: "Integration not found",
				});
			}
			return {
				success: true,
				message: "GITLAB integration disconnected",
			};
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
