import { db } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";

/**
 * AUTHORIZATION: PROJECT_MEMBERS_MANAGE (OWNER, PROJECT_ADMIN, org admin+).
 * Pending invitations are sensitive (reveal who was invited) so this is
 * gated at manage-level, not read-level.
 */
export const listSentInvitationsProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_MEMBERS_MANAGE))
	.route({
		method: "GET",
		path: "/projects/:projectId/members/sent-invitations",
		tags: ["Projects", "Members"],
		summary: "List sent project invitations",
		description:
			"Get all pending invitations sent for a project (owner only)",
	})
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
		}),
	)
	.handler(async ({ input }) => {
		const invitations = await db.projectInvitation.findMany({
			where: { projectId: input.projectId, status: "PENDING" },
			orderBy: { createdAt: "desc" },
		});

		const inviterIds = [
			...new Set(invitations.map((inv) => inv.invitedBy)),
		];
		const inviters = await db.user.findMany({
			where: { id: { in: inviterIds } },
			select: { id: true, name: true, email: true },
		});
		const inviterMap = new Map(inviters.map((u) => [u.id, u]));

		const result = invitations.map((inv) => {
			const inviter = inviterMap.get(inv.invitedBy);
			return {
				id: inv.id,
				email: inv.email,
				role: inv.role,
				status: inv.status,
				expiresAt: inv.expiresAt,
				createdAt: inv.createdAt,
				invitedBy: inv.invitedBy,
				inviterName: inviter?.name ?? null,
				inviterEmail: inviter?.email ?? null,
			};
		});

		return { invitations: result };
	});
