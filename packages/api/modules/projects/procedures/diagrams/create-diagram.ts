import { ORPCError } from "@orpc/client";
import { createDiagram, hasProjectAccess } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";

/**
 * AUTHORIZATION: Uses hasProjectAccess() to verify project membership,
 * then creates diagram with XOR tenant filter.
 */
export const createDiagramProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.DIAGRAM_CREATE))
	.route({
		method: "POST",
		path: "/projects/:projectId/diagrams",
		tags: ["Projects", "Diagrams"],
		summary: "Create a diagram in a project",
	})
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
			title: z.string().optional(),
			elements: z.any(),
			appState: z.any().optional(),
			checkpointId: z.string().optional(),
			mcpConfigId: z.string().optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const orgId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		// Verify project access
		const hasAccess = await hasProjectAccess(
			input.projectId,
			context.user.id,
			orgId ?? undefined,
		);
		if (!hasAccess) {
			throw new ORPCError("FORBIDDEN", {
				message: "No access to this project",
			});
		}

		return createDiagram({
			title: input.title,
			elements: input.elements,
			appState: input.appState,
			checkpointId: input.checkpointId,
			mcpConfigId: input.mcpConfigId,
			userId: context.user.id,
			organizationId: orgId,
			projectId: input.projectId,
		});
	});
