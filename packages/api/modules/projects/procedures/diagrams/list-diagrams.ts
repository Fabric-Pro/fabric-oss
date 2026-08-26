import { listDiagrams } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";

/**
 * AUTHORIZATION: Uses tenantProtectedProcedure + XOR tenant filter via listDiagrams().
 */
export const listDiagramsProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.DIAGRAM_READ))
	.route({
		method: "GET",
		path: "/projects/:projectId/diagrams",
		tags: ["Projects", "Diagrams"],
		summary: "List project diagrams",
	})
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const orgId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);
		return listDiagrams({
			userId: context.user.id,
			organizationId: orgId,
			projectId: input.projectId,
		});
	});
