import { db } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";

/**
 * AUTHORIZATION: `requireProjectPermission(PROJECT_GOVERNANCE_MANAGE)`.
 * Clearing the token invalidates every copy of the link immediately.
 */
export const revokeOutcomesProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_GOVERNANCE_MANAGE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/outcomes/revoke",
		tags: ["Projects", "Outcomes"],
		summary: "Revoke customer outcomes page",
		description: "Invalidate the customer outcomes link for this project",
	})
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
		}),
	)
	.handler(async ({ input }) => {
		await db.project.update({
			where: { id: input.projectId },
			data: { outcomesShareToken: null },
			select: { id: true },
		});
		return { published: false as const };
	});
