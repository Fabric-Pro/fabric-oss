import { ORPCError } from "@orpc/client";
import { getDiagramById } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";

/**
 * AUTHORIZATION: Uses tenantProtectedProcedure + XOR tenant filter via getDiagramById().
 */
export const getDiagramProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.DIAGRAM_READ))
	.route({
		method: "GET",
		path: "/projects/:projectId/diagrams/:diagramId",
		tags: ["Projects", "Diagrams"],
		summary: "Get a diagram",
	})
	.input(
		z.object({
			projectId: z.string(),
			diagramId: z.string(),
			organizationId: z.string().nullable().optional(),
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
		return diagram;
	});
