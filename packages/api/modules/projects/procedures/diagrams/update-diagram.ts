import { ORPCError } from "@orpc/client";
import { getDiagramById, updateDiagram } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";

/**
 * AUTHORIZATION: Uses tenantProtectedProcedure + XOR tenant filter via getDiagramById().
 * Validates that the diagram belongs to the specified project before updating.
 */
export const updateDiagramProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.DIAGRAM_UPDATE))
	.route({
		method: "PUT",
		path: "/projects/:projectId/diagrams/:diagramId",
		tags: ["Projects", "Diagrams"],
		summary: "Update a diagram",
	})
	.input(
		z.object({
			projectId: z.string(),
			diagramId: z.string(),
			organizationId: z.string().nullable().optional(),
			title: z.string().optional(),
			elements: z.any().optional(),
			appState: z.any().optional(),
			checkpointId: z.string().optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const orgId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);
		const diagram = await getDiagramById(
			input.diagramId,
			context.user.id,
			orgId,
		);
		if (!diagram || diagram.projectId !== input.projectId) {
			throw new ORPCError("NOT_FOUND", {
				message: "Diagram not found",
			});
		}
		return updateDiagram({
			diagramId: input.diagramId,
			userId: context.user.id,
			organizationId: orgId,
			title: input.title,
			elements: input.elements,
			appState: input.appState,
			checkpointId: input.checkpointId,
		});
	});
