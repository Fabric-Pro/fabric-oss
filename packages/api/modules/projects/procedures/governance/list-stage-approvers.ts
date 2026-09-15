import { db } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";

/**
 * AUTHORIZATION: `requireProjectPermission(PROJECT_READ)` — anyone who can
 * read the project can see who approves its stage transitions.
 */
export const listStageApproversProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_READ))
	.route({
		method: "GET",
		path: "/projects/:projectId/governance/stage-approvers",
		tags: ["Projects", "Governance"],
		summary: "List stage approvers",
		description:
			"Users configured to approve drafting-stage transitions on this project",
	})
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
		}),
	)
	.handler(async ({ input }) => {
		const approvers = await db.projectStageApprover.findMany({
			where: { projectId: input.projectId },
			orderBy: { createdAt: "asc" },
			select: {
				userId: true,
				createdAt: true,
				user: {
					select: { id: true, name: true, email: true, image: true },
				},
			},
		});

		return { approvers };
	});
